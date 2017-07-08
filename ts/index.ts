import * as events from "events";
import * as _ from "lodash";
import * as uuid from "uuid";

export interface ITransaction {
    execute: () => Promise<any>;
    toJSON: () => any;
}

type TransactionCompletionCallback = (err: any, result: any) => void;

export type TransactionId = string;

interface ITransactionQueueItem {
    Id: TransactionId;
    EnqueueTime: number;
    Transaction: ITransaction;
    CompletionCallback?: TransactionCompletionCallback;
}

export interface ITransactionQueueItemJSON {
    Id: TransactionId;
    EnqueueTime: number;
    Transaction: any;
}

export interface Options {
    TransTimeoutPollingIntervalMS? : number;
    TransTimeoutMS?: number; 
}

export interface ITransactionProcessorJSON {
    Options: Options;
    Busy: boolean;
    Open: boolean;
    Stopped: boolean;
    QueueCount: number;
    ExecutingTransacrion: ITransactionQueueItemJSON;
}

let defaultOptions: Options = {
    TransTimeoutPollingIntervalMS: 5000
    ,TransTimeoutMS: 15000
};

export interface ITransactionProcessor {
    submit: (Transaction: ITransaction) => Promise<TransactionId>;
    transact: <T>(Transaction: ITransaction) => Promise<T>;
    abortAll: () => void;
    abort: (TransactionId: TransactionId) => boolean;
    end: () => void;
    readonly Busy: boolean;
    Open: boolean;
    Stopped: boolean;
    readonly Queue: ITransactionQueueItemJSON[];
    readonly Options: Options;
    toJSON: () => ITransactionProcessorJSON;
    // events
    on(event: "submitted", listener: (itemJSON: ITransactionQueueItemJSON) => void) : this;
    on(event: "change", listener: () => void) : this;
    on(event: "polling-transactions", listener: () => void) : this;
    on(event: "executing-transaction", listener: (transaction: ITransaction, TransactionId: TransactionId) => void) : this;
    on(event: "transaction-success", listener: (transaction: ITransaction, result: any, TransactionId: TransactionId) => void) : this;
    on(event: "transaction-error", listener: (transaction: ITransaction, err: any, TransactionId?: TransactionId) => void) : this;
}

interface IQueue {
    enqueue: (TransactionId: TransactionId, Transaction: ITransaction, CompletionCallback?: TransactionCompletionCallback) => void;
    dequeue: () => ITransactionQueueItem;
    removeTimeoutTransactions: (TransTimeoutMS: number) => void;
    flush: () => void;
    remove: (TransactionId: TransactionId) => boolean;
    readonly Count: number;
    toJSON: () => ITransactionQueueItemJSON[];
    // events
    on(event: "enqueue", listener: (itemJSON: ITransactionQueueItemJSON) => void) : this;
    on(event: "change", listener: () => void) : this;
    on(event: "transactions-timeout", listener: (timeoutItems: ITransactionQueueItem[]) => void) : this;
    on(event: "transactions-removed", listener: (flushedItems: ITransactionQueueItem[]) => void) : this;
}

class Queue extends events.EventEmitter implements IQueue {
    private _items: ITransactionQueueItem[];
    constructor() {
        super();
        this._items = [];
    }
    public static itemToJSON(item: ITransactionQueueItem) : ITransactionQueueItemJSON {
        return {Id: item.Id, EnqueueTime: item.EnqueueTime, Transaction: item.Transaction.toJSON()};
    }
    // enqueue a transaction
    enqueue(TransactionId: TransactionId, Transaction: ITransaction, CompletionCallback?: TransactionCompletionCallback) {
        let item: ITransactionQueueItem = {Id: TransactionId, EnqueueTime: new Date().getTime(), Transaction, CompletionCallback};
        this._items.push(item);
        this.emit("enqueue", Queue.itemToJSON(item));
        this.emit("change");
    }
    // dequeue a transaction
    dequeue() : ITransactionQueueItem {
        if (this._items.length > 0) {
            let item = this._items.shift();
            this.emit("change");
            return item;
        } else
            return null;
    }
    // remove all timeout transactions from the queue
    removeTimeoutTransactions(TransTimeoutMS: number) {
        if (this._items.length > 0) {
            let now = new Date().getTime();
            let indices: number[] = [];
            for (let i = this._items.length - 1; i >= 0; i--) {  // going backward in index
                let item = this._items[i];
                if (now - item.EnqueueTime > TransTimeoutMS)
                    indices.push(i);
            }
            if (indices.length > 0) {
                let timeoutItems: ITransactionQueueItem[] = [];
                for (let i in indices) {
                    let index = indices[i];
                    timeoutItems.push(this._items[index]);
                    this._items.splice(index, 1);
                }
                this.emit("transactions-timeout", timeoutItems);
                this.emit("change");
            }
        }
    }
    // flush the queue
    flush() {
        if (this._items.length > 0) {
            let removedItems = this._items;
            this._items = [];
            this.emit("transactions-removed", removedItems);
            this.emit("change");
        }
    }
    // remove a transaction from the queue
    remove(TransactionId: TransactionId) : boolean {
        if (this._items.length > 0) {
            for (let i in this._items) {
                let item = this._items[i];
                if (item.Id === TransactionId) {
                    this._items.splice(parseInt(i), 1);
                    this.emit("transactions-removed", [item]);
                    this.emit("change");
                    return true;
                }
            }
        }
        return false;
    }
    get Count() : number {
        return this._items.length;
    }
    toJSON() : ITransactionQueueItemJSON[] {
        let ret: ITransactionQueueItemJSON[] = [];
        for (let i in this._items) {
            let item = this._items[i];
            ret.push(Queue.itemToJSON(item));
        }
        return ret;
    }
};

class FIFOTransactionProcessor extends events.EventEmitter implements ITransactionProcessor {
    private _executingTransaction: ITransactionQueueItemJSON;
    private _queue: IQueue;
    private _options: Options;
    private _timer: NodeJS.Timer;
    private _queueOpen: boolean;
    private _stopped: boolean;
    private get PollingTimeoutFunction() : () => void {
        let func = () => {
            this.emit('polling-transactions');
            this._queue.removeTimeoutTransactions(this._options.TransTimeoutMS);
            this._timer = setTimeout(this.PollingTimeoutFunction, this._options.TransTimeoutPollingIntervalMS);
        }
        return func.bind(this);
    }
    constructor(options?: Options) {
        super();
        options = options || defaultOptions;
        this._options = _.assignIn({}, defaultOptions, options);
        this._executingTransaction = null;
        this._queueOpen = true;
        this._stopped = false;
        this._queue = new Queue();
        this._queue.on("enqueue", (itemJSON: ITransactionQueueItemJSON) => {
            this.emit("submitted", itemJSON);
            this.executeTransactionIfNecessary();
        }).on("change", () => {
            this.emit("change");
        }).on("transactions-timeout", (timeoutItems: ITransactionQueueItem[]) => {
            let err = {error: "timeout", error_description: "transaction timeout"};
            for (let i in timeoutItems)
                this.handleTransactionError(timeoutItems[i].Transaction, timeoutItems[i].CompletionCallback, err, timeoutItems[i].Id);
        }).on("transactions-removed", (removedItems: ITransactionQueueItem[]) => {
            let err = {error: "aborted", error_description: "transaction aborted"};
            for (let i in removedItems)
                this.handleTransactionError(removedItems[i].Transaction, removedItems[i].CompletionCallback, err, removedItems[i].Id);
        });
        this._timer = setTimeout(this.PollingTimeoutFunction, this._options.TransTimeoutPollingIntervalMS);
    }
    private handleTransactionError(Transaction: ITransaction, CompletionCallback: TransactionCompletionCallback, err: any, TransactionId: TransactionId) {
        this.emit("transaction-error", Transaction, err, TransactionId);
        if (typeof CompletionCallback === "function") CompletionCallback(err, null);        
    }
    private handleTransactionSuccess(Transaction: ITransaction, CompletionCallback: TransactionCompletionCallback, result: any, TransactionId: TransactionId) {
        this.emit("transaction-success", Transaction, result, TransactionId);
        if (typeof CompletionCallback === "function") CompletionCallback(null, result);
    }
    // abort all transactions currently in the queue
    abortAll() {this._queue.flush();}
    // abort one transaction
    abort(TransactionId: TransactionId) : boolean {return this._queue.remove(TransactionId);}
    // call this before removing this processor reference
    end() {
        this.Open = false;  // close the queue
        this.abortAll();    // abort all transactions
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }
    }
    get Busy(): boolean {return (this._executingTransaction != null);}
    private setExecutingTransaction(value: ITransactionQueueItemJSON) {
        if (this._executingTransaction !== value) {
            this._executingTransaction = value;
            this.emit("change");
            if (!this.Busy)    // becoming not busy
                this.executeTransactionIfNecessary();
        }
    }
    get Open() : boolean {return this._queueOpen;}
    set Open(value: boolean) {
        if (this._queueOpen !== value) {
            this._queueOpen = value;
            this.emit("change");
        }
    }
    get Stopped() : boolean {return this._stopped;}
    set Stopped(value: boolean) {
        if (this._stopped !== value) {
            this._stopped = value;
            this.emit("change");
            if (!this.Stopped)  // becoming not stopped
                this.executeTransactionIfNecessary();
        }
    }
    private executeTransactionIfNecessary() {
        let item: ITransactionQueueItem = null;
        if (!this.Busy && !this.Stopped && (item = this._queue.dequeue())) {
            this.setExecutingTransaction(Queue.itemToJSON(item));
            this.emit("executing-transaction", item.Transaction, item.Id);
            item.Transaction.execute()
            .then((result: any) => {
                this.handleTransactionSuccess(item.Transaction, item.CompletionCallback, result, item.Id);
                this.setExecutingTransaction(null);
            }).catch((err: any) => {
                this.handleTransactionError(item.Transaction, item.CompletionCallback, err, item.Id);
                this.setExecutingTransaction(null);
            });
        }
    }
    private generateTransactionId() : TransactionId {return uuid.v4().replace(/-/gi, "");}
    private get QueueClosedError() : any {return {error: "forbidden", error_description: "submitting transaction is not allowed at this time"};}

    // submit a transaction to be executed
    submit(Transaction: ITransaction) : Promise<TransactionId> {
        return new Promise<TransactionId>((resolve: (value: TransactionId) => void, reject: (err: any) => void) => {
            if (this.Open) {    // queue is open
                let TransactionId = this.generateTransactionId();
                this._queue.enqueue(TransactionId, Transaction, null);
                resolve(TransactionId);
            } else {    // queue is close
                this.handleTransactionError(Transaction, null, this.QueueClosedError, null);
                reject(this.QueueClosedError);
            }
        });
    }
    // commit a transaction
    transact<T>(Transaction: ITransaction) : Promise<T> {
        return new Promise<T>((resolve: (value: T) => void, reject: (err: any) => void) => {
            if (this.Open) {    // queue is open
                this._queue.enqueue(this.generateTransactionId(), Transaction, (err: any, result: T) => {
                    if (err)
                        reject(err);
                    else
                        resolve(result);
                });
            } else {    // queue is close
                this.handleTransactionError(Transaction, null, this.QueueClosedError, null);
                reject(this.QueueClosedError);
            }
        });
    }
    get Queue() : ITransactionQueueItemJSON[] {return this._queue.toJSON();}
    get Options() : Options {return _.assignIn({}, this._options);}
    toJSON() : ITransactionProcessorJSON {
        return {
            Options: this.Options
            ,Busy: this.Busy
            ,Open: this.Open
            ,Stopped: this.Stopped
            ,QueueCount: this._queue.Count
            ,ExecutingTransacrion: this._executingTransaction
        };
    }
}

export function get(options?: Options) : ITransactionProcessor {return new FIFOTransactionProcessor(options);}