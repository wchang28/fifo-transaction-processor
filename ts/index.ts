import * as events from "events";
import * as _ from "lodash";

export type TransactionCompletionCallback = (err: any, result: any) => void;

export interface ITransaction {
    execute: () => Promise<any>;
    readonly CompletionCallback?: TransactionCompletionCallback;
    toJSON: () => any;
}

interface ITransactionQueueItem {
    EnqueueTime: number;
    Transaction: ITransaction;
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
    submit: (Transaction: ITransaction) => void;
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
    enqueue: (Transaction: ITransaction) => void;
    dequeue: () => ITransaction;
    removeTimeoutTransactions: (TransTimeoutMS: number) => void;
    flush: () => void;
    readonly Count: number;
    toJSON: () => ITransactionQueueItemJSON[];
    on: (event: QueueEvents, listener: Function) => this;
}

// this class emits the following events
// 1. enqueue (itemJSON: ITransactionQueueItemJSON)
// 2. change ()
// 3. transactions-timeout (timeoutTransactions: ITransaction[])
// 4. transactions-flushed (flushedTransactions: ITransaction[])
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
    enqueue(Transaction: ITransaction) {
        let item: ITransactionQueueItem = {EnqueueTime: new Date().getTime(), Transaction};
        this._items.push(item);
        this.emit("enqueue", this.itemToJSON(item));
        this.emit("change");
    }
    // dequeue a transaction
    dequeue() : ITransaction {
        if (this._items.length > 0) {
            let item = this._items.shift();
            this.emit("change");
            return item.Transaction;
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
                let timeoutTransactions: ITransaction[] = [];
                for (let i in indices) {
                    let index = indices[i];
                    timeoutTransactions.push(this._items[index].Transaction);
                    this._items.splice(index, 1);
                }
                this.emit("transactions-timeout", timeoutTransactions);
                this.emit("change");
            }
        }
    }
    // flush the queue
    flush() {
        if (this._items.length > 0) {
            let flushedTransactions : ITransaction[] = [];
            for (let i in this._items)
                flushedTransactions.push(this._items[i].Transaction);
            this._items = [];
            this.emit("transactions-flushed", flushedTransactions);
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
export class SequentialTransactionProcessor extends events.EventEmitter implements ITransactionProcessor {
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
        }).on("transactions-timeout", (timeoutTransactions: ITransaction[]) => {
            let err = {error: "timeout", error_description: "transaction timeout"};
            for (let i in timeoutTransactions)
                this.handleTransactionError(timeoutTransactions[i], err);
        }).on("transactions-flushed", (flushedTransactions: ITransaction[]) => {
            let err = {error: "aborted", error_description: "transaction aborted"};
            for (let i in flushedTransactions)
                this.handleTransactionError(flushedTransactions[i], err);
        });
        this._timer = setTimeout(this.PollingTimeoutFunction, this._options.TransTimeoutPollingIntervalMS);
    }
    private handleTransactionError(Transaction: ITransaction, err: any) {
        this.emit("transaction-error", Transaction, err);
        let CompletionCallback = Transaction.CompletionCallback;
        if (typeof CompletionCallback === "function") CompletionCallback(err, null);        
    }
    private handleTransactionSuccess(Transaction: ITransaction, result: any) {
        this.emit("transaction-success", Transaction, result);
        let CompletionCallback = Transaction.CompletionCallback;
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
        let Transaction: ITransaction = null;
        if (!this.Busy && (Transaction = this._queue.dequeue())) {
            this.setBusy(true);
            this.emit("executing-transaction", Transaction);
            Transaction.execute()
            .then((result: any) => {
                this.handleTransactionSuccess(Transaction, result);
                this.setBusy(false);
            }).catch((err: any) => {
                this.handleTransactionError(Transaction, err);
                this.setBusy(false);
            });
        }
    }
    // submit a transaction to be executed
    submit(Transaction: ITransaction) {
        if (this.Open) // queue is open
            this._queue.enqueue(Transaction);
        else  // queue is close
            this.handleTransactionError(Transaction, {error: "forbidden", error_description: "transaction is not allowed at this time"});
    }
    get Queue() : ITransactionQueueItemJSON[] {return this._queue.toJSON();}
    get Options() : Options {return _.assignIn({}, this._options);}
    toJSON() : ITransactionProcessorJSON {return {Options: this.Options, Busy: this.Busy, Open: this.Open, QueueCount: this._queue.Count};}
}