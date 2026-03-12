# Zantara VTU & Fintech Backend

A high-integrity, production-ready VTU & Bill Payment backend built for speed, security, and financial traceability. The system supports Airtime, Data, Electricity, Cable TV, and Exam PINs with integrated Wallet Ledger and KYC enforcement.

---

## 🛡️ Fintech Safety & Integrity (The Golden Rules)

This backend is built on five core safety principles mandated for financial operations:
1.  **Zero Direct Mutation**: Wallet balances are never updated directly. All movements MUST go through `WalletService`.
2.  **Ledger-First Architecture**: Every credit, debit, freeze, or refund is recorded in the `WalletLedger`.
3.  **Atomic Sequence**: Financial operations follow a "Debit-First" flow to prevent over-spending.
4.  **Webhook Idempotency**: All provider notifications are tracked in `WebhookEvent`.
5.  **Secure PIN & KYC**: Sensitive operations require a hashed 4-digit Transaction PIN.

---

## 📖 API Documentation Reference

### 🔐 Authentication (`/api/auth`)

#### 1. Register User
- **Purpose**: Registers a new user and auto-creates a wallet.
- **Method**: `POST` | **Path**: `/register`
- **Request Body**: `{ "name": "...", "email": "...", "phone": "...", "password": "..." }`
- **Response**: `{ "success": true, "token": "..." }`

#### 2. Login
- **Purpose**: Authenticates user and returns JWT.
- **Method**: `POST` | **Path**: `/login`
- **Response**: `{ "success": true, "token": "..." }`

#### 3. Forget/Reset Password
- **POST** `/forgot-password`: Sends recovery email.
- **PUT** `/reset-password/:token`: Sets new password via email token.

#### 4. Email Verification
- **GET** `/verify-email/:token`: Activates account via email link.

#### 5. PIN Management
- **POST** `/set-pin`: Sets initial 4-digit safety PIN.
- **POST** `/change-pin`: Updates PIN (Headers: `{ "oldPin": "...", "newPin": "..." }`).

---

### 💳 Wallet & Funding (`/api/wallet`)

#### 1. Balance Retrieval
- **Purpose**: Get current available and frozen balance.
- **Method**: `GET` | **Path**: `/`
- **Response**: `{ "balance": 5000, "frozen": 0 }`

#### 2. Funding Init
- **Purpose**: Setup Paystack session.
- **Method**: `POST` | **Path**: `/fund`
- **Request Body**: `{ "amount": 1000 }`
- **Response**: `{ "authorization_url": "...", "reference": "..." }`

#### 3. Verification
- **GET** `/verify`: Checks reference status manually.

---

### 📲 Services (`/api/services`)

#### 1. Fetch Plans
- **Purpose**: Get bundle codes for various networks.
- **Method**: `GET` | **Path**: `/plans/:network`
- **Response**: `{ "data": [ { "variation_code": "..." } ] }`

#### 2. Purchase Airtime
- **Purpose**: Secure VTU top-up.
- **Method**: `POST` | **Path**: `/airtime`
- **Request Body**: `{ "network": "MTN", "phone": "...", "amount": 100, "pin": "1234" }`
- **Response**: `{ "status": "success", "data": { "ref": "..." } }`

#### 3. Meter Validation
- **Method**: `POST` | **Path**: `/electricity/verify/meter`
- **Request Body**: `{ "billersCode": "...", "serviceID": "...", "type": "prepaid" }`
- **Response**: `{ "data": { "name": "..." } }`

#### 4. Bills & PINs
- **POST** `/electricity`: Pay utility bill.
- **POST** `/cable`: Recharge TV subscription.
- **POST** `/purchase-pin`: Bulk buy Exam/Utility PINs.

---

### 👤 KYC & Support (`/api/kyc` | `/api/support`)

#### 1. KYC Submission
- **Method**: `POST` | **Path**: `/api/kyc/submit`
- **Headers**: `multipart/form-data`
- **Body**: `tier`, `documentType`, `documentNumber`, `document` (image).

#### 2. Support Tickets
- **POST** `/api/support/create`: Open new case.
- **POST** `/api/support/reply/:id`: Respond to thread.

---

### 📊 Admin Control & Analytics (`/api/admin` | `/api/analytics`)

#### 1. Analytics
- **GET** `/analytics/transactions/daily`: Success count/revenue stats.
- **GET** `/analytics/services/top-used`: Service popularity rank.
- **GET** `/analytics/users/registrations/daily`: Growth tracking.

#### 2. Global Audit
- **GET** `/admin/transactions`: Global filtered transaction history.
- **GET** `/admin/users`: Exhaustive list of all registered users.
- **PUT** `/admin/users/:id`: Block/Unblock or change user roles.
- **POST** `/admin/settings`: Manage global system config (Keys/Limits).

#### 3. Process Withdrawals
- **PUT** `/api/withdrawal/:id`: Approve/Reject payout request.

---

### 💸 Withdrawal Module (`/api/withdrawal`)

#### 1. Flow
- **POST** `/`: Create payout request (Freezes funds).
- **GET** `/me`: Personal request history.

---

### 📜 Transaction Logs (`/api/transaction-logs`)

#### 1. User History
- **Purpose**: Personal ledger and purchase history.
- **Method**: `GET` | **Path**: `/`
- **Response**: `[ { "type": "airtime", "amount": 100, "status": "success" } ]`

#### 2. Single Detail
- **GET** `/:id`: Full payload status for a specific transaction ID.

---
© 2026 Zantara Fintech Systems. All rights reserved.