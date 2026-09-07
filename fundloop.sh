#!/bin/bash
cd "$(dirname "$0")"
for i in $(seq 1 40); do
  if [ -f chain.json ]; then echo "[$(date +%H:%M:%S)] CHAIN READY"; break; fi
  echo "[$(date +%H:%M:%S)] attempt $i"
  timeout 70 node bootstrap.js 2>&1 | grep -v "429\|Retrying" | tail -4
  if [ -f chain.json ]; then echo "[$(date +%H:%M:%S)] CHAIN READY"; break; fi
  sleep 120
done
