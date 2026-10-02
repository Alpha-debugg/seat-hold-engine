# Seat Hold Engine

## Install and Run

```bash
npm install
npm test
```

## What It Does

The engine supports:

- Holding a single seat
- Confirming a hold
- Releasing a hold
- Checking seat status
- Holding multiple seats using `holdMany()`
- Maximum 4 active holds per user
- Automatic/lazy expiration of holds
- Same-user retry without extending the hold
- Concurrent operations using locks
- Injectable clock for testing
- Atomic `holdMany()` operations


## What Is Not Included

This project intentionally focuses only on the core in-memory engine.

It does not include:

- Frontend/UI
- React
- Express or REST API
- Database
- Authentication
- Payment Integration
- Real ticket booking