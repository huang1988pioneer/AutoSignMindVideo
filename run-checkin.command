#!/bin/zsh
cd "$(dirname "$0")"
mkdir -p logs
/usr/bin/env node checkin.js 2>&1 | tee -a logs/checkin.log
