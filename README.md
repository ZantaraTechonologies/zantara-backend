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

Zantara provides a **wallet‑driven fintech infrastructure** supporting digital value services such as:
- Airtime & Data purchases (MTN, Airtel, Glo, 9mobile)
- Electricity token payments (IKEDC, EKEDC, etc.)
- Cable TV subscriptions (DSTV, GOTV, Startimes)
- Exam PIN purchases (WAEC, NECO)
- Automated wallet funding via Paystack/Monnify
- Tiered KYC identity verification
- Support ticket management

Every financial action is recorded through a **transaction record and wallet ledger entry**, ensuring the system remains fully auditable.

---

## 2. Core Safety Principles

This backend is built on five core safety principles mandated for financial operations:
1. **Ledger‑First Architecture**: Every financial movement (Credit/Debit) is recorded in the Wallet Ledger.
2. **No Direct Wallet Mutations**: Wallet balances can only change through the `WalletService`.
3. **Transaction‑First Execution**: A transaction record is created *before* performing external financial actions.
4. **Idempotent Webhooks**: Provider webhooks are tracked in `WebhookEvent` to prevent double-crediting.
5. **Atomic Financial Sequence**: Operations follow a strict "Debit-First" flow to prevent over-spending even if external APIs fail.

---

## 3. Technology Stack

- **Runtime**: Node.js (v16.x or higher)
- **Web Framework**: Express.js
- **Database**: MongoDB with Mongoose ODM
- **Authentication**: JWT (JSON Web Tokens)
- **Payments**: Paystack API
- **Utilities**: NodeMailer, BcryptJS, Axios

---

## 4. System Architecture

The project utilizes a **Layered Service-Adapter Architecture**:
- **Routes Layer**: Entry point for API requests.
- **Controller Layer**: Handles request validation and response formatting.
- **Service Layer**: Contains core business logic and financial arithmetic.
- **Adapter Layer**: Abstracts third-party VTU and Payment gateway details.
- **Data Layer**: Mongoose models and database interactions.

---

## 5. Project Structure

```text
/vtu-backend
├── controllers/    # Request handlers (Thin Controllers)
├── models/         # Database schemas (User, Wallet, Transaction, etc.)
├── routes/         # API Route definitions
├── services/       # Core business logic (WalletService, PurchaseService)
├── utils/          # Helper functions (Mailer, Response, ID Generators)
├── server.js       # App entry point
└── .env            # Environment configuration
```

---

## 6. Installation

1. Clone the repository:
   ```bash
   git clone <repo-url>
   cd vtu-backend
   ```
2. Install dependencies:
   ```bash
   npm install
   ```

---

## 7. Environment Configuration

Create a `.env` file in the root directory:
```env
PORT=5000
MONGODB_URI=mongodb://localhost:27017/zantara
JWT_SECRET=your_jwt_secret
PAYSTACK_SECRET_KEY=sk_test_...
ADMIN_EMAIL=admin@zantara.com
```

---

## 8. Running the Application

- **Development Mode**: `npm run dev` (starts with nodemon)
- **Production Mode**: `npm start`

---

## 9. Security Model

- **Authentication**: All sensitive routes require a valid JWT `Bearer` token.
- **Authorization**: Role-based access control (RBAC) specifically for Admin and Support roles.
- **Transaction PIN**: A hashed 4-digit PIN is required for all debiting operations.
- **Rate Limiting**: Protection against brute-force on Auth and PIN endpoints.
- **KYC Tiers**: Limits transaction volume based on verification level.

---

## 10. Wallet & Ledger System

Zantara strictly separates **Balance** from the **Audit Trail**:
- **Wallet Model**: Stores `balance` and `frozen` amounts.
- **WalletLedger Model**: Logs every single change to the wallet. 
- *Rule*: Balance MUST always equal the sum of all Ledger entries.

---

## 11. Transaction Lifecycle

1. **Initiate**: Transaction status set to `pending`.
2. **Authorize**: PIN verification and balance check.
3. **Debit**: Wallet is debited through `WalletService` (Ledger created).
4. **External Provider**: Request sent to VTU/Payment provider.
5. **Finalize**: Success or Failure response updates the transaction status.
6. **Refund**: If provider fails, funds are automatically returned to wallet (Ledger created).

---

## 12. API Reference (Exhaustive)

### 🔐 Authentication (`/api/auth`)

#### 1. Register User
- **Purpose**: Registers a new user and auto-creates a wallet.
- **Method**: `POST` | **Path**: `/register`
- **Headers**: `Content-Type: application/json`
- **Request Body**:
```json
{ "name": "John Doe", "email": "john@example.com", "phone": "0801...", "password": "pass" }
```
- **Expected Response**: `{ "success": true, "token": "..." }`
- **Notes**: Immediately issues access token.

#### 2. User Login
- **Purpose**: Authenticates user and returns JWT.
- **Method**: `POST` | **Path**: `/login`
- **Request Body**: `{ "email": "...", "password": "..." }`
- **Expected Response**: `{ "success": true, "token": "..." }`

#### 3. PIN Management
- **Purpose**: Sets or changes the 4-digit safety PIN.
- **Method**: `POST` | **Path**: `/set-pin`
- **Request Body**: `{ "pin": "1234" }`
- **Expected Response**: `{ "success": true, "message": "PIN updated" }`

---

### 💳 Wallet & Funding (`/api/wallet`)

#### 1. Get Balance
- **Purpose**: Retrieves available and frozen funds.
- **Method**: `GET` | **Path**: `/`
- **Headers**: `Authorization: Bearer <token>`
- **Expected Response**: `{ "balance": 5000, "frozen": 0 }`

#### 2. Fund Wallet
- **Purpose**: Initializes a Paystack checkout session.
- **Method**: `POST` | **Path**: `/fund`
- **Request Body**: `{ "amount": 1000 }`
- **Expected Response**: `{ "authorization_url": "...", "reference": "..." }`

---

### 📲 Services (`/api/services`)

#### 1. Airtime Purchase
- **Purpose**: Purchase mobile airtime.
- **Method**: `POST` | **Path**: `/airtime`
- **Request Body**: `{ "network": "MTN", "phone": "...", "amount": 100, "pin": "1234" }`
- **Expected Response**: `{ "message": "Airtime sent successfully" }`
- **Notes**: Requires valid Transaction PIN.

#### 2. Meter Verification
- **Purpose**: Validates meter number before electricity payment.
- **Method**: `POST` | **Path**: `/electricity/verify/meter`
- **Request Body**: `{ "billersCode": "...", "serviceID": "...", "type": "prepaid" }`
- **Expected Response**: `{ "data": { "name": "..." } }`

---

### 👤 KYC & Support (`/api/kyc` | `/api/support`)

#### 1. KYC Submission
- **Purpose**: Upload ID for account upgrade.
- **Method**: `POST` | **Path**: `/api/kyc/submit`
- **Headers**: `multipart/form-data`
- **Request Body**: `tier`, `documentType`, `documentNumber`, `document` (image).
- **Expected Response**: `{ "message": "KYC pending" }`

#### 2. Create Ticket
- **Purpose**: Open a support thread.
- **Method**: `POST` | **Path**: `/api/support/create`
- **Request Body**: `{ "subject": "...", "message": "..." }`
- **Expected Response**: `{ "success": true, "message": "Ticket created" }`

---

## 13. Webhook Handling

Zantara handles asynchronous notifications from:
- **Paystack**: Automatic wallet crediting on successful card/transfer payments.
- **Monnify**: Provider for virtual accounts and instant funding.
- **Security**: All webhooks verify IP addresses or HMAC signatures to ensure authenticity.

---

## 14. Admin & Analytics

- **Admin Access**: Restricted routes for managing users, approving KYC, and processing withdrawals.
- **Analytics**: Aggregated data on daily revenue, transaction volume, and popular services.
- **Logging**: All administrative actions (KYC approval, balance adjustment) are logged in `AdminLog` for accountability.

---

© 2026 Zantara Fintech Systems. All rights reserved.