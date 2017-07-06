import * as events from "events";
import * as _ from "lodash";

export interface ITransaction {
    execute: () => Promise<any>;
    toJSON: () => any;
}

type TransactionCompletionCallback = (err: any, result: any) => void;

interface ITransactionQueueItem {
    EnqueueTime: number;
    Transaction: ITransaction;
    CompletionCallback?: TransactionCompletionCallback;
}

export interface ITransactionQueueItemJSON {
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
    QueueCount: number;
}

let defaultOptions: Options = {
    TransTimeoutPollingIntervalMS: 5000
    ,TransTimeoutMS: 15000
};

export type ProcessorEvents = "submitted" | "change" | "polling-transactions" | "executing-transaction" | "transaction-success" | "transaction-error";

export interface ITransactionProcessor {
    submit: <T>(Transaction: ITransaction, Wait?: boolean) => Promise<T>;
    abortAll: () => void;
    end: () => void;
    readonly Busy: boolean;
    Open: boolean;
    readonly Queue: ITransactionQueueItemJSON[];
    Options: Options;
    toJSON: () => ITransactionProcessorJSON;
    on: (event: ProcessorEvents, listener: Function) => this;
}

type QueueEvents = "enqueue" | "change" | "transactions-timeout" | "transactions-flushed";

interface IQueue {
    enqueue: (Transaction: ITransaction, CompletionCallback?: TransactionCompletionCallback) => void;
    dequeue: () => ITransactionQueueItem;
    removeTimeoutTransactions: (TransTimeoutMS: number) => void;
    flush: () => void;
    readonly Count: number;
    toJSON: () => ITransactionQueueItemJSON[];
    on: (event: QueueEvents, listener: Function) => this;
}

// this class emits the following events
// 1. enqueue (itemJSON: ITransactionQueueItemJSON)
// 2. change ()
// 3. transactions-timeout (timeoutItems: ITransactionQueueItem[])
// 4. transactions-flushed (flushedItems: ITransactionQueueItem[])
class Queue extends events.EventEmitter implements IQueue {
    private _items: ITransactionQueueItem[];
    constructor() {
        super();
        this._items = [];
    }
    private itemToJSON(item: ITransactionQueueItem) : ITransactionQueueItemJSON {
        return {EnqueueTime: item.EnqueueTime, Transaction: item.Transaction.toJSON()};
    }
    // enqueue a transaction
    enqueue(Transaction: ITransaction, CompletionCallback?: TransactionCompletionCallback) {
        let item: ITransactionQueueItem = {EnqueueTime: new Date().getTime(), Transaction, CompletionCallback};
        this._items.push(item);
        this.emit("enqueue", this.itemToJSON(item));
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
            let flushedItems = this._items;
            this._items = [];
            this.emit("transactions-flushed", flushedItems);
            this.emit("change");
        }
    }
    get Count() : number {
        return this._items.length;
    }
    toJSON() : ITransactionQueueItemJSON[] {
        let ret: ITransactionQueueItemJSON[] = [];
        for (let i in this._items) {
            let item = this._items[i];
            ret.push(this.itemToJSON(item));
        }
        return ret;
    }
};

// this class emits the following events
// 1. submitted (itemJSON: ITransactionQueueItemJSON)
// 2. change ()
// 3. polling-transactions ()
// 4. executing-transaction (transaction: ITransaction)
// 5. transaction-success (transaction: ITransaction, result: any)
// 6. transaction-error (transaction: ITransaction, err: any)
export class FIFOTransactionProcessor extends events.EventEmitter implements ITransactionProcessor {
    private _executingTransaction: boolean;
    private _queue: IQueue;
    private _options: Options;
    private _timer: NodeJS.Timer;
    private _queueOpen: boolean;
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
        this._executingTransaction = false;
        this._queueOpen = true;
        this._queue = new Queue();
        this._queue.on("enqueue", (itemJSON: ITransactionQueueItemJSON) => {
            this.emit("submitted", itemJSON);
            this.executeTransactionIfNecessary();
        }).on("change", () => {
            this.emit("change");
        }).on("transactions-timeout", (timeoutItems: ITransactionQueueItem[]) => {
            let err = {error: "timeout", error_description: "transaction timeout"};
            for (let i in timeoutItems)
                this.handleTransactionError(timeoutItems[i].Transaction, timeoutItems[i].CompletionCallback, err);
        }).on("transactions-flushed", (flushedItems: ITransactionQueueItem[]) => {
            let err = {error: "aborted", error_description: "transaction aborted"};
            for (let i in flushedItems)
                this.handleTransactionError(flushedItems[i].Transaction, flushedItems[i].CompletionCallback, err);
        });
        this._timer = setTimeout(this.PollingTimeoutFunction, this._options.TransTimeoutPollingIntervalMS);
    }
    private handleTransactionError(Transaction: ITransaction, CompletionCallback: TransactionCompletionCallback, err: any) {
        this.emit("transaction-error", Transaction, err);
        if (typeof CompletionCallback === "function") CompletionCallback(err, null);        
    }
    private handleTransactionSuccess(Transaction: ITransaction, CompletionCallback: TransactionCompletionCallback, result: any) {
        this.emit("transaction-success", Transaction, result);
        if (typeof CompletionCallback === "function") CompletionCallback(null, result);
    }
    // abort all transactions currently in the queue
    abortAll() {this._queue.flush();}
    // call this before removing this processor reference
    end() {
        this.Open = false;  // close the queue
        this.abortAll();    // abort all transactions
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }
    }
    get Busy(): boolean {return this._executingTransaction;}
    private setBusy(value: boolean) {
        if (this._executingTransaction !== value) {
            this._executingTransaction = value;
            this.emit("change");
            if (!this._executingTransaction)    // becoming not busy
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
    private executeTransactionIfNecessary() {
        let item: ITransactionQueueItem = null;
        if (!this.Busy && (item = this._queue.dequeue())) {
            this.setBusy(true);
            this.emit("executing-transaction", item.Transaction);
            item.Transaction.execute()
            .then((result: any) => {
                this.handleTransactionSuccess(item.Transaction, item.CompletionCallback, result);
                this.setBusy(false);
            }).catch((err: any) => {
                this.handleTransactionError(item.Transaction, item.CompletionCallback, err);
                this.setBusy(false);
            });
        }
    }
    // submit a transaction to be executed
    submit<T>(Transaction: ITransaction, Wait: boolean = true) : Promise<T> {
        return new Promise<T>((resolve: (value: T) => void, reject: (err: any) => void) => {
            if (this.Open) {    // queue is open
                this._queue.enqueue(Transaction, Wait ? (err: any, result: T) => {
                    if (err)
                        reject(err);
                    else
                        resolve(result);
                } : null);
                if (!Wait) resolve(null);
            } else {    // queue is close
                let err: any = {error: "forbidden", error_description: "submitting transaction is not allowed at this time"};
                this.handleTransactionError(Transaction, null, err);
                reject(err);
            }
        });
    }
    get Queue() : ITransactionQueueItemJSON[] {return this._queue.toJSON();}
    get Options() : Options {return _.assignIn({}, this._options);}
    toJSON() : ITransactionProcessorJSON {return {Options: this.Options, Busy: this.Busy, Open: this.Open, QueueCount: this._queue.Count};}
}