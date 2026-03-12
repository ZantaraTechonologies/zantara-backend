# Zantara Fintech Backend

A **secure, high‑integrity VTU and digital payments backend** designed for wallet-based financial services.  
Zantara powers airtime purchases, data bundles, electricity payments, cable subscriptions, exam PIN sales, and wallet operations while maintaining **strict financial traceability and safety controls**.

---

## 🧭 Table of Contents

1. [Overview](#1-overview)
2. [Core Safety Principles](#2-core-safety-principles)
3. [Technology Stack](#3-technology-stack)
4. [System Architecture](#4-system-architecture)
5. [Project Structure](#5-project-structure)
6. [Installation](#6-installation)
7. [Environment Configuration](#7-environment-configuration)
8. [Running the Application](#8-running-the-application)
9. [Security Model](#9-security-model)
10. [Wallet & Ledger System](#10-wallet--ledger-system)
11. [Transaction Lifecycle](#11-transaction-lifecycle)
12. [API Reference (Exhaustive)](#12-api-reference-exhaustive)
13. [Webhook Handling](#13-webhook-handling)
14. [Admin & Analytics](#14-admin--analytics)

---

## 1. Overview

Zantara provides a **wallet‑driven fintech infrastructure** supporting digital value services such as Airtime, Data, Utility Bills, and Exam PINs. Every financial action is recorded through a **transaction record and wallet ledger entry**, ensuring the system remains fully auditable.

---

## 2. Core Safety Principles

- **Ledger‑First Architecture**: Every financial movement is recorded in the Wallet Ledger.
- **No Direct Wallet Mutations**: Wallet balances can only change through the `WalletService`.
- **Transaction‑First Execution**: A transaction record is created *before* performing financial actions.
- **Idempotent Webhooks**: Provider webhooks are tracked and processed exactly once.

---

## 12. API Reference (Exhaustive)

### 🔐 Authentication (`/api/auth`)

#### 1. Register User
- **Purpose**: Registers a new user and initializes a wallet.
- **Method**: `POST` | **Path**: `/register`
- **Headers**: `Content-Type: application/json`
- **Request Body**: `{ "name": "...", "email": "...", "phone": "...", "password": "..." }`
- **Expected Response**: `{ "success": true, "token": "..." }`
- **Notes**: Returns a JWT token for immediate session access.

#### 2. User Login
- **Purpose**: Authenticates credentials and returns a session token.
- **Method**: `POST` | **Path**: `/login`
- **Request Body**: `{ "email": "...", "password": "..." }`
- **Expected Response**: `{ "success": true, "token": "..." }`

#### 3. Update User Info
- **Purpose**: Updates profile details.
- **Method**: `PUT` | **Path**: `/users/:id`
- **Headers**: `Authorization: Bearer <token>`
- **Request Body**: `{ "name": "...", "phone": "..." }`
- **Expected Response**: `{ "success": true, "data": { "name": "..." } }`

#### 4. Forgot Password
- **Purpose**: Sends a reset link to the user's email.
- **Method**: `POST` | **Path**: `/forgot-password`
- **Request Body**: `{ "email": "john@example.com" }`
- **Expected Response**: `{ "message": "Reset link sent" }`

#### 5. Reset Password
- **Purpose**: Sets a new password using a token.
- **Method**: `PUT` | **Path**: `/reset-password/:token`
- **Request Body**: `{ "password": "..." }`
- **Expected Response**: `{ "message": "Password updated" }`

#### 6. PIN Management
- **Purpose**: Sets or changes the 4-digit safety PIN.
- **Method**: `POST` | **Path**: `/set-pin` | `/change-pin`
- **Request Body**: `{ "pin": "1234" }` or `{ "oldPin": "...", "newPin": "..." }`
- **Expected Response**: `{ "success": true, "message": "PIN updated" }`

---

### 💳 Wallet & Funding (`/api/wallet`)

#### 1. Fetch Balance
- **Purpose**: Retrieves available and frozen balances.
- **Method**: `GET` | **Path**: `/`
- **Expected Response**: `{ "balance": 5000, "frozen": 0 }`

#### 2. Fund Wallet
- **Purpose**: Generates Paystack checkout URL.
- **Method**: `POST` | **Path**: `/fund`
- **Request Body**: `{ "amount": 1000 }`
- **Expected Response**: `{ "authorization_url": "...", "reference": "..." }`

#### 3. Verify Funding
- **Purpose**: Manual status check.
- **Method**: `GET` | **Path**: `/verify?reference=REF`
- **Expected Response**: `{ "status": "success" }`

---

### 📲 Services (`/api/services`)

#### 1. Fetch Plans
- **Purpose**: Get bundle codes for networks/cables.
- **Method**: `GET` | **Path**: `/plans/:network`
- **Expected Response**: `{ "data": [ { "variation_code": "..." } ] }`

#### 2. Purchase Airtime
- **Purpose**: Top up phone credit.
- **Method**: `POST` | **Path**: `/airtime`
- **Request Body**: `{ "network": "MTN", "phone": "...", "amount": 100, "pin": "1234" }`
- **Expected Response**: `{ "message": "Airtime sent successfully" }`

#### 3. Purchase Data
- **Purpose**: Buy mobile data bundles.
- **Method**: `POST` | **Path**: `/data`
- **Request Body**: `{ "serviceID": "...", "billersCode": "...", "variation_code": "...", "phone": "...", "amount": 350, "pin": "..." }`
- **Expected Response**: `{ "message": "Data purchase successful" }`

#### 4. Electricity Payment
- **Purpose**: Pay electricity bill.
- **Method**: `POST` | **Path**: `/electricity`
- **Request Body**: `{ "serviceID": "...", "meter_number": "...", "amount": 2000, "pin": "..." }`
- **Expected Response**: `{ "message": "Electricity bill paid" }`

#### 5. Meter Verification
- **Purpose**: Validate customer details.
- **Method**: `POST` | **Path**: `/electricity/verify/meter`
- **Request Body**: `{ "billersCode": "...", "serviceID": "...", "type": "prepaid" }`
- **Expected Response**: `{ "data": { "name": "..." } }`

#### 6. Exam PINs
- **Purpose**: Bulk purchase of Exam pins.
- **Method**: `POST` | **Path**: `/purchase-pin`
- **Request Body**: `{ "variation_code": "...", "amount": 1500, "quantity": 1, "pin": "..." }`
- **Expected Response**: `{ "message": "PIN purchased", "data": { "pin": "..." } }`

---

### 👤 KYC & Support (`/api/kyc` | `/api/support`)

#### 1. KYC Submission
- **Method**: `POST` | **Path**: `/submit`
- **Headers**: `multipart/form-data`
- **Expected Response**: `{ "message": "KYC pending review" }`

#### 2. Create Ticket
- **Purpose**: Support request.
- **Method**: `POST` | **Path**: `/create`
- **Request Body**: `{ "subject": "...", "message": "..." }`
- **Expected Response**: `{ "success": true, "message": "Ticket created" }`

#### 3. Reply to Ticket
- **Purpose**: Conversation on ticket.
- **Method**: `POST` | **Path**: `/reply/:id`
- **Request Body**: `{ "message": "..." }`
- **Expected Response**: `{ "message": "Reply sent" }`

---

### 📊 Admin Control (`/api/admin`)

#### 1. Global Audit
- **Purpose**: View all platform transactions.
- **Method**: `GET` | **Path**: `/transactions`
- **Expected Response**: `{ "success": true, "data": [...] }`

#### 2. Process Withdrawals
- **Purpose**: Approve/Reject payout.
- **Method**: `PUT` | **Path**: `/withdrawals/:id`
- **Request Body**: `{ "status": "approved", "adminNote": "..." }`
- **Expected Response**: `{ "message": "Withdrawal processed" }`

---

### 💸 Withdrawals (`/api/withdrawal`)

#### 1. User Request
- **Purpose**: Payout request.
- **Method**: `POST` | **Path**: `/`
- **Request Body**: `{ "amount": 5000 }`
- **Expected Response**: `{ "message": "Request submitted" }`
- **Notes**: Freezes funds immediately.

---

© 2026 Zantara Fintech Systems. All rights reserved.