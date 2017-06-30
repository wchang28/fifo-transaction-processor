"use strict";
var __extends = (this && this.__extends) || (function () {
    var extendStatics = Object.setPrototypeOf ||
        ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
        function (d, b) { for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p]; };
    return function (d, b) {
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
var events = require("events");
var _ = require("lodash");
var defaultOptions = {
    TransTimeoutPollingIntervalMS: 5000,
    TransTimeoutMS: 15000
};
// this class emits the following events
// 1. enqueue (itemJSON: ITransactionQueueItemJSON)
// 2. change ()
// 3. transactions-timeout (timeoutTransactions: ITransaction[])
// 4. transactions-flushed (flushedTransactions: ITransaction[])
var Queue = (function (_super) {
    __extends(Queue, _super);
    function Queue() {
        var _this = _super.call(this) || this;
        _this._items = [];
        return _this;
    }
    Queue.prototype.itemToJSON = function (item) {
        return { EnqueueTime: item.EnqueueTime, Transaction: item.Transaction.toJSON() };
    };
    // enqueue a transaction
    Queue.prototype.enqueue = function (Transaction) {
        var item = { EnqueueTime: new Date().getTime(), Transaction: Transaction };
        this._items.push(item);
        this.emit("enqueue", this.itemToJSON(item));
        this.emit("change");
    };
    // dequeue a transaction
    Queue.prototype.dequeue = function () {
        if (this._items.length > 0) {
            var item = this._items.shift();
            this.emit("change");
            return item.Transaction;
        }
        else
            return null;
    };
    // remove all timeout transactions from the queue
    Queue.prototype.removeTimeoutTransactions = function (TransTimeoutMS) {
        if (this._items.length > 0) {
            var now = new Date().getTime();
            var indices = [];
            for (var i = this._items.length - 1; i >= 0; i--) {
                var item = this._items[i];
                if (now - item.EnqueueTime > TransTimeoutMS)
                    indices.push(i);
            }
            if (indices.length > 0) {
                var timeoutTransactions = [];
                for (var i in indices) {
                    var index = indices[i];
                    timeoutTransactions.push(this._items[index].Transaction);
                    this._items.splice(index, 1);
                }
                this.emit("transactions-timeout", timeoutTransactions);
                this.emit("change");
            }
        }
    };
    // flush the queue
    Queue.prototype.flush = function () {
        if (this._items.length > 0) {
            var flushedTransactions = [];
            for (var i in this._items)
                flushedTransactions.push(this._items[i].Transaction);
            this._items = [];
            this.emit("transactions-flushed", flushedTransactions);
            this.emit("change");
        }
    };
    Object.defineProperty(Queue.prototype, "Count", {
        get: function () {
            return this._items.length;
        },
        enumerable: true,
        configurable: true
    });
    Queue.prototype.toJSON = function () {
        var ret = [];
        for (var i in this._items) {
            var item = this._items[i];
            ret.push(this.itemToJSON(item));
        }
        return ret;
    };
    return Queue;
}(events.EventEmitter));
;
// this class emits the following events
// 1. submitted (itemJSON: ITransactionQueueItemJSON)
// 2. change ()
// 3. polling-transactions ()
// 4. executing-transaction (transaction: ITransaction)
// 5. transaction-success (transaction: ITransaction, result: any)
// 6. transaction-error (transaction: ITransaction, err: any)
var FIFOTransactionProcessor = (function (_super) {
    __extends(FIFOTransactionProcessor, _super);
    function FIFOTransactionProcessor(options) {
        var _this = _super.call(this) || this;
        options = options || defaultOptions;
        _this._options = _.assignIn({}, defaultOptions, options);
        _this._executingTransaction = false;
        _this._queueOpen = true;
        _this._queue = new Queue();
        _this._queue.on("enqueue", function (itemJSON) {
            _this.emit("submitted", itemJSON);
            _this.executeTransactionIfNecessary();
        }).on("change", function () {
            _this.emit("change");
        }).on("transactions-timeout", function (timeoutTransactions) {
            var err = { error: "timeout", error_description: "transaction timeout" };
            for (var i in timeoutTransactions)
                _this.handleTransactionError(timeoutTransactions[i], err);
        }).on("transactions-flushed", function (flushedTransactions) {
            var err = { error: "aborted", error_description: "transaction aborted" };
            for (var i in flushedTransactions)
                _this.handleTransactionError(flushedTransactions[i], err);
        });
        _this._timer = setTimeout(_this.PollingTimeoutFunction, _this._options.TransTimeoutPollingIntervalMS);
        return _this;
    }
    Object.defineProperty(FIFOTransactionProcessor.prototype, "PollingTimeoutFunction", {
        get: function () {
            var _this = this;
            var func = function () {
                _this.emit('polling-transactions');
                _this._queue.removeTimeoutTransactions(_this._options.TransTimeoutMS);
                _this._timer = setTimeout(_this.PollingTimeoutFunction, _this._options.TransTimeoutPollingIntervalMS);
            };
            return func.bind(this);
        },
        enumerable: true,
        configurable: true
    });
    FIFOTransactionProcessor.prototype.handleTransactionError = function (Transaction, err) {
        this.emit("transaction-error", Transaction, err);
        var CompletionCallback = Transaction.CompletionCallback;
        if (typeof CompletionCallback === "function")
            CompletionCallback(err, null);
    };
    FIFOTransactionProcessor.prototype.handleTransactionSuccess = function (Transaction, result) {
        this.emit("transaction-success", Transaction, result);
        var CompletionCallback = Transaction.CompletionCallback;
        if (typeof CompletionCallback === "function")
            CompletionCallback(null, result);
    };
    // abort all transactions currently in the queue
    FIFOTransactionProcessor.prototype.abortAll = function () { this._queue.flush(); };
    // call this before removing this processor reference
    FIFOTransactionProcessor.prototype.end = function () {
        this.Open = false; // close the queue
        this.abortAll(); // abort all transactions
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }
    };
    Object.defineProperty(FIFOTransactionProcessor.prototype, "Busy", {
        get: function () { return this._executingTransaction; },
        enumerable: true,
        configurable: true
    });
    FIFOTransactionProcessor.prototype.setBusy = function (value) {
        if (this._executingTransaction !== value) {
            this._executingTransaction = value;
            this.emit("change");
            if (!this._executingTransaction)
                this.executeTransactionIfNecessary();
        }
    };
    Object.defineProperty(FIFOTransactionProcessor.prototype, "Open", {
        get: function () { return this._queueOpen; },
        set: function (value) {
            if (this._queueOpen !== value) {
                this._queueOpen = value;
                this.emit("change");
            }
        },
        enumerable: true,
        configurable: true
    });
    FIFOTransactionProcessor.prototype.executeTransactionIfNecessary = function () {
        var _this = this;
        var Transaction = null;
        if (!this.Busy && (Transaction = this._queue.dequeue())) {
            this.setBusy(true);
            this.emit("executing-transaction", Transaction);
            Transaction.execute()
                .then(function (result) {
                _this.handleTransactionSuccess(Transaction, result);
                _this.setBusy(false);
            }).catch(function (err) {
                _this.handleTransactionError(Transaction, err);
                _this.setBusy(false);
            });
        }
    };
    // submit a transaction to be executed
    FIFOTransactionProcessor.prototype.submit = function (Transaction) {
        if (this.Open)
            this._queue.enqueue(Transaction);
        else
            this.handleTransactionError(Transaction, { error: "forbidden", error_description: "transaction is not allowed at this time" });
    };
    Object.defineProperty(FIFOTransactionProcessor.prototype, "Queue", {
        get: function () { return this._queue.toJSON(); },
        enumerable: true,
        configurable: true
    });
    Object.defineProperty(FIFOTransactionProcessor.prototype, "Options", {
        get: function () { return _.assignIn({}, this._options); },
        enumerable: true,
        configurable: true
    });
    FIFOTransactionProcessor.prototype.toJSON = function () { return { Options: this.Options, Busy: this.Busy, Open: this.Open, QueueCount: this._queue.Count }; };
    return FIFOTransactionProcessor;
}(events.EventEmitter));
exports.FIFOTransactionProcessor = FIFOTransactionProcessor;