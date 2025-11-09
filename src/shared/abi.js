// src/shared/abi.js
export const ABI = {
  Opened: [
    {
      "anonymous": false,
      "inputs": [
        { "indexed": true,  "internalType": "uint32", "name": "id", "type": "uint32" },
        { "indexed": false, "internalType": "uint8",  "name": "state", "type": "uint8" },
        { "indexed": true,  "internalType": "uint32", "name": "asset", "type": "uint32" },
        { "indexed": false, "internalType": "bool",   "name": "longSide", "type": "bool" },
        { "indexed": false, "internalType": "uint16", "name": "lots", "type": "uint16" },
        { "indexed": false, "internalType": "int64",  "name": "entryOrTargetX6", "type": "int64" },
        { "indexed": false, "internalType": "int64",  "name": "slX6", "type": "int64" },
        { "indexed": false, "internalType": "int64",  "name": "tpX6", "type": "int64" },
        { "indexed": false, "internalType": "int64",  "name": "liqX6", "type": "int64" },
        { "indexed": true,  "internalType": "address","name": "trader", "type": "address" },
        { "indexed": false, "internalType": "uint16", "name": "leverageX", "type": "uint16" }
      ],
      "name": "Opened",
      "type": "event"
    }
  ],

  Executed: [
    {
      "anonymous": false,
      "inputs": [
        { "indexed": true,  "internalType": "uint32", "name": "id", "type": "uint32" },
        { "indexed": false, "internalType": "int64",  "name": "entryX6", "type": "int64" }
      ],
      "name": "Executed",
      "type": "event"
    }
  ],

  StopsUpdated: [
    {
      "anonymous": false,
      "inputs": [
        { "indexed": true,  "internalType": "uint32", "name": "id", "type": "uint32" },
        { "indexed": false, "internalType": "int64",  "name": "slX6", "type": "int64" },
        { "indexed": false, "internalType": "int64",  "name": "tpX6", "type": "int64" }
      ],
      "name": "StopsUpdated",
      "type": "event"
    }
  ],

  Removed: [
    {
      "anonymous": false,
      "inputs": [
        { "indexed": true,  "internalType": "uint32",  "name": "id", "type": "uint32" },
        { "indexed": false, "internalType": "uint8",   "name": "reason", "type": "uint8" },
        { "indexed": false, "internalType": "int64",   "name": "execX6", "type": "int64" },
        { "indexed": false, "internalType": "int256",  "name": "pnlUsd6", "type": "int256" }
      ],
      "name": "Removed",
      "type": "event"
    }
  ],

 Getters: [
    {
      "inputs":[{"internalType":"uint32","name":"id","type":"uint32"}],
      "name":"getTrade",
      "outputs":[{"components":[
        {"internalType":"address","name":"owner","type":"address"},
        {"internalType":"uint32","name":"asset","type":"uint32"},
        {"internalType":"uint16","name":"lots","type":"uint16"},
        {"internalType":"uint8","name":"flags","type":"uint8"},
        {"internalType":"uint8","name":"_pad0","type":"uint8"},
        {"internalType":"int64","name":"entryX6","type":"int64"},
        {"internalType":"int64","name":"targetX6","type":"int64"},
        {"internalType":"int64","name":"slX6","type":"int64"},
        {"internalType":"int64","name":"tpX6","type":"int64"},
        {"internalType":"int64","name":"liqX6","type":"int64"},
        {"internalType":"uint16","name":"leverageX","type":"uint16"},
        {"internalType":"uint16","name":"_pad1","type":"uint16"},
        {"internalType":"uint64","name":"marginUsd6","type":"uint64"}],
        "internalType":"struct Trades.Trade","name":"","type":"tuple"}],
      "stateMutability":"view","type":"function"
    },
    // déjà présent chez toi :
    "function stateOf(uint32 id) view returns (uint8)"
  ],
};

