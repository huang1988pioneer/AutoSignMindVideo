# Product

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

## Stack

Delegated: .NET 8 with Avalonia UI, chosen to deliver a Windows-first desktop app while keeping the UI portable.

## Users

MindVideo users who manage one or more accounts and want to complete the daily check-in without handling command-line environment variables.

## Product Purpose

Provide a local desktop workspace for adding MindVideo account tokens, checking daily eligibility, submitting a check-in, and seeing the resulting credits and streak.

## Positioning

The tool brings the existing strict MindVideo check-in verification flow into a local, account-oriented desktop UI; it does not automate browser logins or transmit tokens anywhere except MindVideo's API.

## Operating Context

Users run the app manually on Windows. Tokens are stored only in the user's local application-data folder and are never displayed in full after saving.

## Capabilities and Constraints

- Supports multiple named MindVideo accounts.
- Uses the existing MindVideo check-in records, check-in, token refresh, and credit stats endpoints.
- First release is Windows-first; Avalonia leaves future cross-platform support possible.
- Token storage is a local configuration file by explicit user choice.
- Browser login/token capture and scheduled background runs are out of scope for this UI release.

## Brand Commitments

Traditional Chinese is the primary UI language. The app should feel trustworthy, direct, and calm.

## Evidence on Hand

The repository contains `checkin.js`, the verified API behavior, and `accounts.json` labels. No existing visual identity or image assets are supplied.

## Product Principles

- Make check-in state understandable before action is taken.
- Keep credentials private by default.
- Preserve strict verification instead of reporting a check-in as successful prematurely.
- Let users act on one account or all saved accounts.
