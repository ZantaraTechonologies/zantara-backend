# Zantara Fintech Backend

A **secure, high‑integrity VTU and digital payments backend** designed for wallet-based financial services.  
Zantara powers airtime purchases, data bundles, electricity payments, cable subscriptions, exam PIN sales, and wallet operations while maintaining **strict financial traceability and safety controls**.

---

## 🧭 Table of Contents

- [Zantara Fintech Backend](#zantara-fintech-backend)
  - [🧭 Table of Contents](#-table-of-contents)
- [1. Overview](#1-overview)
- [2. Core Safety Principles](#2-core-safety-principles)
    - [1. Ledger‑First Architecture](#1-ledgerfirst-architecture)
    - [2. No Direct Wallet Mutations](#2-no-direct-wallet-mutations)
    - [3. Transaction‑First Execution](#3-transactionfirst-execution)
    - [4. Idempotent Webhooks](#4-idempotent-webhooks)
    - [5. Transaction PIN Security](#5-transaction-pin-security)
- [3. Technology Stack](#3-technology-stack)
- [4. System Architecture](#4-system-architecture)
- [5. Project Structure](#5-project-structure)
- [6. Installation](#6-installation)
- [7. Environment Configuration](#7-environment-configuration)
- [8. Running the Application](#8-running-the-application)
- [9. Security Model](#9-security-model)
    - [JWT Authentication](#jwt-authentication)
    - [Role‑Based Authorization](#rolebased-authorization)
    - [Transaction PIN](#transaction-pin)
    - [KYC Enforcement](#kyc-enforcement)
    - [Rate Limiting](#rate-limiting)
- [10. Wallet \& Ledger System](#10-wallet--ledger-system)
- [11. Transaction Lifecycle](#11-transaction-lifecycle)
  - [12. API Reference (Exhaustive)](#12-api-reference-exhaustive)
    - [12.1 Authentication (`/api/auth`)](#121-authentication-apiauth)
      - [1. Register User](#1-register-user)
      - [2. User Login](#2-user-login)
      - [3. Forget Password](#3-forget-password)
      - [4. Reset Password](#4-reset-password)
      - [5. User Logout](#5-user-logout)
      - [6. PIN Management](#6-pin-management)
    - [12.2 Wallet \& Funding (`/api/wallet`)](#122-wallet--funding-apiwallet)
      - [1. Get Balance](#1-get-balance)
      - [2. Fund Wallet](#2-fund-wallet)
      - [3. Verify Funding (Manual Poll)](#3-verify-funding-manual-poll)
    - [12.3 Services Module (`/api/services`)](#123-services-module-apiservices)
      - [1. Fetch Plans](#1-fetch-plans)
      - [2. Purchase Airtime](#2-purchase-airtime)
      - [3. Purchase Data](#3-purchase-data)
      - [4. Electricity Payment](#4-electricity-payment)
      - [5. Meter Verification](#5-meter-verification)
      - [6. Cable TV](#6-cable-tv)
      - [7. Exam PINs](#7-exam-pins)
      - [8. Purchased PINs History](#8-purchased-pins-history)
      - [9. Check Transaction Status](#9-check-transaction-status)
    - [12.4 KYC Module (`/api/kyc`)](#124-kyc-module-apikyc)
      - [1. Submit KYC](#1-submit-kyc)
      - [2. My KYC Status](#2-my-kyc-status)
    - [12.5 Support Module (`/api/support`)](#125-support-module-apisupport)
      - [1. Create Ticket](#1-create-ticket)
      - [2. My Tickets](#2-my-tickets)
      - [3. Reply to Ticket](#3-reply-to-ticket)
    - [12.6 Withdrawal Module (`/api/withdrawal`)](#126-withdrawal-module-apiwithdrawal)
      - [1. Request Payout](#1-request-payout)
      - [2. My Withdrawals](#2-my-withdrawals)
    - [12.7 Transactions (`/api/transaction-logs`)](#127-transactions-apitransaction-logs)
      - [1. My History](#1-my-history)
      - [2. Single Detail](#2-single-detail)
    - [12.8 Notifications (`/api/notifications`)](#128-notifications-apinotifications)
      - [1. Get List](#1-get-list)
      - [2. Mark as Read](#2-mark-as-read)
    - [12.9 Admin Control (`/api/admin`)](#129-admin-control-apiadmin)
      - [1. User Management](#1-user-management)
      - [2. Role/Block Update](#2-roleblock-update)
      - [3. KYC Audit](#3-kyc-audit)
      - [4. Support Audit](#4-support-audit)
      - [5. Process Withdrawals](#5-process-withdrawals)
    - [12.10 Analytics (`/api/admin/stats`)](#1210-analytics-apiadminstats)
      - [1. Daily Reports](#1-daily-reports)
  - [13. Webhook Handling](#13-webhook-handling)
- [14. Admin \& Analytics](#14-admin--analytics)
- [15. Testing](#15-testing)
- [16. Deployment Notes](#16-deployment-notes)
- [17. Roadmap](#17-roadmap)
    
---

# 1. Overview

Zantara provides a **wallet‑driven fintech infrastructure** supporting digital value services such as:

- Airtime purchases
- Data bundle purchases
- Electricity token payments
- Cable TV subscriptions
- Exam PIN purchases
- Wallet funding
- Referral rewards
- KYC identity verification
- Support ticket management

Every financial action is recorded through a **transaction record and wallet ledger entry**, ensuring the system remains fully auditable.

---

# 2. Core Safety Principles

The backend enforces several critical safety rules:

### 1. Ledger‑First Architecture
Every financial movement is recorded in the **Wallet Ledger**.

### 2. No Direct Wallet Mutations
Wallet balances can only change through the **WalletService**.

### 3. Transaction‑First Execution
A transaction record is created before performing financial actions.

### 4. Idempotent Webhooks
Provider webhooks are tracked and processed once.

### 5. Transaction PIN Security
Sensitive operations require a hashed 4‑digit transaction PIN.

These rules protect against:

- double spending
- balance corruption
- replay attacks
- webhook duplication

---

# 3. Technology Stack

Typical stack used in the backend:

- Node.js
- Express.js
- MongoDB / Mongoose
- JWT Authentication
- Paystack Payment Gateway
- VTU Service Providers
- Cloud Storage (for KYC documents)
- Redis (optional caching / queues)

---

# 4. System Architecture

The backend follows a layered architecture.

Client Applications  
↓  
API Routes  
↓  
Controllers  
↓  
Business Services  
↓  
Data Models  
↓  
Database  
↓  
External Providers

Each layer has a dedicated responsibility, improving scalability and maintainability.

---

# 5. Project Structure

Example structure:

```
src/
  controllers/
  services/
  models/
  routes/
  middleware/
  adapters/
  jobs/
  utils/
  config/
```

Key responsibilities:

Controllers → request handling  
Services → business logic  
Models → database schemas  
Adapters → external provider integration  

---

# 6. Installation

Clone the repository:

```
git clone https://github.com/your-org/zantara-backend.git
cd zantara-backend
```

Install dependencies:

```
npm install
```

---

# 7. Environment Configuration

Create a `.env` file in the root directory.

Example variables:

```
PORT=5000
MONGO_URI=mongodb://localhost/zantara

JWT_SECRET=your_jwt_secret

PAYSTACK_SECRET_KEY=your_key
PAYSTACK_WEBHOOK_SECRET=your_secret

EMAIL_HOST=smtp.mail.com
EMAIL_USER=example@mail.com
EMAIL_PASS=password

VTPASS_API_KEY=api_key
VTPASS_SECRET=secret_key
```

Never commit `.env` files to version control.

---

# 8. Running the Application

Start development server:

```
npm run dev
```

Start production server:

```
npm start
```

---

# 9. Security Model

The platform implements several security layers.

### JWT Authentication
Users authenticate via JWT tokens.

### Role‑Based Authorization
Admin endpoints require elevated roles.

### Transaction PIN
Sensitive wallet operations require a transaction PIN.

### KYC Enforcement
Service limits may depend on KYC verification level.

### Rate Limiting
API endpoints are protected against abuse.

---

# 10. Wallet & Ledger System

Every user has a **wallet** associated with their account.

Wallet fields:

- balance
- frozen balance
- user reference

However, **wallet balance is not the source of truth**.

The true financial record is the **Wallet Ledger**, which tracks:

- credits
- debits
- refunds
- freezes
- referral rewards

Example ledger entry:

```
{
  type: "debit",
  amount: 1000,
  source: "airtime_purchase",
  transactionId: "..."
}
```

---

# 11. Transaction Lifecycle

Every purchase follows a strict lifecycle.

1. Request validation
2. Transaction record creation
3. Wallet balance check
4. Wallet debit
5. Ledger entry creation
6. External provider request
7. Provider response handling
8. Transaction status update
9. Notification delivery

Possible statuses:

```
pending
processing
success
failed
refunded
reversed
```

If a provider fails, a **wallet refund is automatically issued**.

---

## 12. API Reference (Exhaustive)

### 12.1 Authentication (`/api/auth`)

#### 1. Register User
- **Purpose**: Registers a new user and auto-creates a wallet.
- **Method**: `POST` | **Path**: `/register`
- **Headers**: `Content-Type: application/json`
- **Request Body**: `{ "name": "...", "email": "...", "phone": "...", "password": "..." }`
- **Expected Response**: `{ "success": true, "token": "..." }`
- **Notes**: Immediately issues access token.

#### 2. User Login
- **Purpose**: Authenticates user and returns JWT.
- **Method**: `POST` | **Path**: `/login`
- **Request Body**: `{ "email": "...", "password": "..." }`
- **Expected Response**: `{ "success": true, "token": "..." }`

#### 3. Forget Password
- **Purpose**: Sends a reset link to the user's email.
- **Method**: `POST` | **Path**: `/forgot-password`
- **Request Body**: `{ "email": "john@example.com" }`
- **Expected Response**: `{ "message": "Reset link sent" }`

#### 4. Reset Password
- **Purpose**: Sets a new password using a token.
- **Method**: `PUT` | **Path**: `/reset-password/:token`
- **Request Body**: `{ "password": "..." }`
- **Expected Response**: `{ "message": "Password updated" }`

#### 5. User Logout
- **Purpose**: Destroys session/client-side token context.
- **Method**: `POST` | **Path**: `/logout`
- **Expected Response**: `{ "success": true, "message": "Logged out" }`

#### 6. PIN Management
- **Purpose**: Sets or changes the 4-digit safety PIN.
- **Method**: `POST` | **Path**: `/set-pin` | `/change-pin`
- **Request Body**: `{ "pin": "1234" }` or `{ "oldPin": "...", "newPin": "..." }`
- **Expected Response**: `{ "success": true, "message": "PIN updated" }`

---

### 12.2 Wallet & Funding (`/api/wallet`)

#### 1. Get Balance
- **Purpose**: Retrieves available and frozen funds.
- **Method**: `GET` | **Path**: `/`
- **Headers**: `Authorization: Bearer <token>`
- **Expected Response**: `{ "balance": 5000, "frozen": 0 }`

#### 2. Fund Wallet
- **Purpose**: Initializes a Paystack checkout session.
- **Method**: `POST` | **Path**: `/fund`
- **Request Body**: `{ "amount": 1000, "channels": ["card"] }`
- **Expected Response**: `{ "authorization_url": "...", "reference": "..." }`

#### 3. Verify Funding (Manual Poll)
- **Purpose**: Checks status of a funding reference.
- **Method**: `GET` | **Path**: `/verify?reference=REF`
- **Expected Response**: `{ "status": "success" }`

---

### 12.3 Services Module (`/api/services`)

#### 1. Fetch Plans
- **Purpose**: Get bundle codes for networks/cables.
- **Method**: `GET` | **Path**: `/plans/:network`
- **Expected Response**: `{ "data": [ { "variation_code": "..." } ] }`

#### 2. Purchase Airtime
- **Purpose**: Top up phone credit via service provider.
- **Method**: `POST` | **Path**: `/airtime`
- **Request Body**: `{ "network": "MTN", "phone": "...", "amount": 100, "pin": "1234" }`
- **Expected Response**: `{ "message": "Airtime sent successfully" }`

#### 3. Purchase Data
- **Purpose**: Buy mobile data bundles.
- **Method**: `POST` | **Path**: `/data`
- **Request Body**: `{ "serviceID": "...", "billersCode": "...", "variation_code": "...", "phone": "...", "amount": 500, "pin": "..." }`
- **Expected Response**: `{ "message": "Data purchase successful" }`

#### 4. Electricity Payment
- **Purpose**: Pay utility bills and get token.
- **Method**: `POST` | **Path**: `/electricity`
- **Request Body**: `{ "serviceID": "...", "meter_number": "...", "meter_type": "prepaid", "amount": 2000, "pin": "..." }`
- **Expected Response**: `{ "message": "Electricity bill paid" }`

#### 5. Meter Verification
- **Purpose**: Validate customer details before payment.
- **Method**: `POST` | **Path**: `/electricity/verify/meter`
- **Request Body**: `{ "billersCode": "...", "serviceID": "...", "type": "prepaid" }`
- **Expected Response**: `{ "data": { "name": "..." } }`

#### 6. Cable TV
- **Purpose**: Recharge TV subscription (DSTV/GOTV).
- **Method**: `POST` | **Path**: `/cable`
- **Request Body**: `{ "serviceID": "...", "billersCode": "...", "variation_code": "...", "amount": 1000, "pin": "..." }`
- **Expected Response**: `{ "message": "Cable subscription successful" }`

#### 7. Exam PINs
- **Purpose**: Bulk purchase of Exam pins (WAEC/NECO).
- **Method**: `POST` | **Path**: `/purchase-pin`
- **Request Body**: `{ "variation_code": "...", "amount": 1500, "quantity": 1, "pin": "..." }`
- **Expected Response**: `{ "message": "PIN purchased", "data": { "pin": "..." } }`

#### 8. Purchased PINs History
- **Purpose**: Retrieve list of previously bought Exam/Utility PINs.
- **Method**: `GET` | **Path**: `/purchased-pins`
- **Expected Response**: `{ "data": { "pins": [...] } }`

#### 9. Check Transaction Status
- **Purpose**: Manually verify status of any purchase via ref ID.
- **Method**: `POST` | **Path**: `/transaction/status`
- **Request Body**: `{ "refId": "..." }`
- **Expected Response**: `{ "success": true, "status": "success" }`

---

### 12.4 KYC Module (`/api/kyc`)

#### 1. Submit KYC
- **Purpose**: Upload ID for tiered account upgrades.
- **Method**: `POST` | **Path**: `/submit`
- **Headers**: `multipart/form-data`
- **Expected Response**: `{ "message": "KYC pending" }`
- **Notes**: Documents uploaded to internal storage or cloud.

#### 2. My KYC Status
- **Purpose**: Check verification progress.
- **Method**: `GET` | **Path**: `/my-status`
- **Expected Response**: `{ "success": true, "data": { "status": "pending" } }`

---

### 12.5 Support Module (`/api/support`)

#### 1. Create Ticket
- **Purpose**: Open a new support case.
- **Method**: `POST` | **Path**: `/create`
- **Request Body**: `{ "subject": "...", "message": "...", "priority": "high" }`
- **Expected Response**: `{ "success": true, "message": "Ticket created" }`

#### 2. My Tickets
- **Purpose**: View personal support history.
- **Method**: `GET` | **Path**: `/my-tickets`
- **Expected Response**: `{ "data": [...] }`

#### 3. Reply to Ticket
- **Purpose**: Post a response to an active thread.
- **Method**: `POST` | **Path**: `/reply/:id`
- **Request Body**: `{ "message": "..." }`
- **Expected Response**: `{ "message": "Reply sent" }`

---

### 12.6 Withdrawal Module (`/api/withdrawal`)

#### 1. Request Payout
- **Purpose**: Initiate fund withdrawal to bank.
- **Method**: `POST` | **Path**: `/`
- **Request Body**: `{ "amount": 5000 }`
- **Expected Response**: `{ "message": "Request submitted" }`
- **Notes**: Freezes the amount in the user's wallet immediately.

#### 2. My Withdrawals
- **Purpose**: History of personal payout requests.
- **Method**: `GET` | **Path**: `/me`
- **Expected Response**: `[ { "amount": 5000, "status": "pending" } ]`

---

### 12.7 Transactions (`/api/transaction-logs`)

#### 1. My History
- **Purpose**: Personal purchase and ledger history.
- **Method**: `GET` | **Path**: `/`
- **Expected Response**: `[ { "type": "airtime", "amount": 100 } ]`

#### 2. Single Detail
- **Purpose**: Full status and payload for one transaction.
- **Method**: `GET` | **Path**: `/:id`
- **Expected Response**: `{ "success": true, "data": { "refId": "..." } }`

---

### 12.8 Notifications (`/api/notifications`)

#### 1. Get List
- **Purpose**: Fetch all user alerts and system messages.
- **Method**: `GET` | **Path**: `/`
- **Expected Response**: `{ "data": [...] }`

#### 2. Mark as Read
- **Method**: `POST` | **Path**: `/read/:id`
- **Expected Response**: `{ "success": true }`

---

### 12.9 Admin Control (`/api/admin`)

#### 1. User Management
- **Purpose**: View all platform users.
- **Method**: `GET` | **Path**: `/api/admin/users`
- **Expected Response**: `{ "success": true, "data": [...] }`

#### 2. Role/Block Update
- **Purpose**: Update user permissions or ban account.
- **Method**: `PUT` | **Path**: `/api/admin/users/:id`
- **Request Body**: `{ "role": "admin", "status": "blocked" }`
- **Expected Response**: `{ "success": true }`

#### 3. KYC Audit
- **Purpose**: Review all pending submissions.
- **Method**: `GET` | **Path**: `/api/kyc/all`
- **Expected Response**: `{ "data": [...] }`

#### 4. Support Audit
- **Purpose**: View all platform tickets.
- **Method**: `GET` | **Path**: `/api/support/all`
- **Expected Response**: `{ "data": [...] }`

#### 5. Process Withdrawals
- **Purpose**: Approve/Reject payout and finalize ledger.
- **Method**: `PUT` | **Path**: `/api/withdrawal/:id`
- **Request Body**: `{ "status": "approved", "adminNote": "..." }`
- **Expected Response**: `{ "message": "Withdrawal processed" }`

---

### 12.10 Analytics (`/api/admin/stats`)

#### 1. Daily Reports
- **GET** `/transactions/daily`: Transaction volume trends.
- **GET** `/transactions/daily-revenue`: Financial success stats.
- **GET** `/services/top-used`: Product popularity.

---

## 13. Webhook Handling
Zantara integrates secure webhooks for auto-funding:
- **Paystack**: `/webhooks/paystack`
- **Monnify**: `/webhooks/monnify`
- **Flutterwave**: `/webhooks/flutterwave`

*Security Note*: All webhooks enforce IP whitelisting or HMAC signature verification.

---

# 14. Admin & Analytics

Admin features include:

- transaction monitoring
- user management
- KYC approval/rejection
- wallet adjustments
- system configuration

Analytics endpoints provide:

- daily transaction statistics
- top used services
- user growth metrics

---

# 15. Testing

Run automated tests:

```
npm test
```

Testing should cover:

- authentication
- wallet funding
- transaction flow
- provider integrations
- webhook handling

---

# 16. Deployment Notes

Production deployment recommendations:

- use HTTPS
- secure webhook endpoints
- configure database backups
- rotate API keys regularly
- monitor transaction failures

Infrastructure may include:

- load balancer
- queue system
- background workers

---

# 17. Roadmap

Potential improvements:

- advanced reconciliation dashboard
- fraud detection rules
- real‑time provider monitoring
- microservice decomposition
- improved retry queues

---

---
© 2026 Zantara Fintech Systems. All rights reserved.