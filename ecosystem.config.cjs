module.exports = {
  apps: [
    {
      name: "brokex-opened",
      script: "src/opened.js",
      cwd: ".",
      env_file: ".env",
      autorestart: true,
      watch: false,
      max_restarts: 20,
      exp_backoff_restart_delay: 1000,
      max_memory_restart: "300M",
      out_file: "logs/opened.out.log",
      error_file: "logs/opened.err.log",
      node_args: "--enable-source-maps"
    },
    {
      name: "brokex-endpoint",
      script: "src/endpoint.js",
      cwd: ".",
      env_file: ".env",
      autorestart: true,
      out_file: "logs/endpoint.out.log",
      error_file: "logs/endpoint.err.log"
    },
    {
      name: "brokex-executed",
      script: "src/executed.js",
      cwd: ".",
      env_file: ".env",
      autorestart: true,
      watch: false,
      max_restarts: 20,
      exp_backoff_restart_delay: 1000,
      max_memory_restart: "300M",
      out_file: "logs/executed.out.log",
      error_file: "logs/executed.err.log",
      node_args: "--enable-source-maps"
    },
    {
      name: "brokex-stops",
      script: "src/stopsUpdated.js",
      cwd: ".",
      env_file: ".env",
      autorestart: true,
      watch: false,
      max_restarts: 20,
      exp_backoff_restart_delay: 1000,
      max_memory_restart: "300M",
      out_file: "logs/stops.out.log",
      error_file: "logs/stops.err.log",
      node_args: "--enable-source-maps"
    },
    {
      name: "brokex-removed",
      script: "src/removed.js",
      cwd: ".",
      env_file: ".env",
      autorestart: true,
      watch: false,
      max_restarts: 20,
      exp_backoff_restart_delay: 1000,
      max_memory_restart: "300M",
      out_file: "logs/removed.out.log",
      error_file: "logs/removed.err.log",
      node_args: "--enable-source-maps"
    },
    {
      name: "brokex-api",
      script: "src/server.js",
      cwd: ".",
      env_file: ".env",
      autorestart: true,
      watch: false,
      max_restarts: 20,
      exp_backoff_restart_delay: 1000,
      max_memory_restart: "300M",
      out_file: "logs/api.out.log",
      error_file: "logs/api.err.log",
      node_args: "--enable-source-maps"
    }
  ]
};
