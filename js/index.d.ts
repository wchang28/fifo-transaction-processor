/// <reference types="node" />
import * as events from "events";
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
export declare type ProcessorEvents = "submitted" | "change" | "polling-transactions" | "executing-transaction" | "transaction-success" | "transaction-error";
export interface ITransactionProcessor {
    submit: (Transaction: ITransaction) => Promise<TransactionId>;
    transact: <T>(Transaction: ITransaction) => Promise<T>;
    abortAll: () => void;
    end: () => void;
    readonly Busy: boolean;
    Open: boolean;
    Stopped: boolean;
    readonly Queue: ITransactionQueueItemJSON[];
    readonly Options: Options;
    toJSON: () => ITransactionProcessorJSON;
    on: (event: ProcessorEvents, listener: Function) => this;
}
export declare class FIFOTransactionProcessor extends events.EventEmitter implements ITransactionProcessor {
    private _executingTransaction;
    private _queue;
    private _options;
    private _timer;
    private _queueOpen;
    private _stopped;
    private readonly PollingTimeoutFunction;
    constructor(options?: Options);
    private handleTransactionError(Transaction, CompletionCallback, err, TransactionId);
    private handleTransactionSuccess(Transaction, CompletionCallback, result, TransactionId);
    abortAll(): void;
    end(): void;
    readonly Busy: boolean;
    private setExecutingTransaction(value);
    Open: boolean;
    Stopped: boolean;
    private executeTransactionIfNecessary();
    private generateTransactionId();
    private readonly QueueClosedError;
    submit(Transaction: ITransaction): Promise<TransactionId>;
    transact<T>(Transaction: ITransaction): Promise<T>;
    readonly Queue: ITransactionQueueItemJSON[];
    readonly Options: Options;
    toJSON(): ITransactionProcessorJSON;
}
