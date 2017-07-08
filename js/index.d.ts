export interface ITransaction {
    execute: () => Promise<any>;
    toJSON: () => any;
}
export declare type TransactionId = string;
export interface ITransactionQueueItemJSON {
    Id: TransactionId;
    EnqueueTime: number;
    Transaction: any;
}
export interface Options {
    TransTimeoutPollingIntervalMS?: number;
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
    on(event: "submitted", listener: (itemJSON: ITransactionQueueItemJSON) => void): this;
    on(event: "change", listener: () => void): this;
    on(event: "polling-transactions", listener: () => void): this;
    on(event: "executing-transaction", listener: (transaction: ITransaction, TransactionId: TransactionId) => void): this;
    on(event: "transaction-success", listener: (transaction: ITransaction, result: any, TransactionId: TransactionId) => void): this;
    on(event: "transaction-error", listener: (transaction: ITransaction, err: any, TransactionId?: TransactionId) => void): this;
}
export declare function get(options?: Options): ITransactionProcessor;
