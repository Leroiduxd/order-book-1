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
  ]
};

