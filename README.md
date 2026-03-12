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

### 🔐 Authentication Module (`/api/auth`)

#### 1. Register User
- **Purpose**: Registers a new user and auto-creates a wallet.
- **Method**: `POST`
- **Path**: `/register`
- **Headers**: `Content-Type: application/json`
- **Request Body**:
```json
{
  "name": "John Doe",
  "email": "john@example.com",
  "phone": "08012345678",
  "password": "SecurePassword123"
}
```
- **Response**:
```json
{ "success": true, "message": "Registration successful", "token": "..." }
```
- **Notes**: Returns JWT token immediately for auto-login.

#### 2. User Login
- **Purpose**: Authenticates user and returns JWT.
- **Method**: `POST`
- **Path**: `/login`
- **Request Body**:
```json
{
  "email": "john@example.com",
  "password": "SecurePassword123"
}
```
- **Response**:
```json
{ "success": true, "token": "..." }
```
- **Notes**: Authenticated via HTTP-only cookie or Bearer token.

#### 3. Update User Info
- **Purpose**: Updates profile details (name, phone).
- **Method**: `PUT`
- **Path**: `/users/:id`
- **Headers**: `Authorization: Bearer <token>`
- **Request Body**:
```json
{ "name": "New Name", "phone": "08012345678" }
```
- **Response**:
```json
{ "success": true, "data": { "_id": "...", "name": "New Name" } }
```

#### 4. Transaction PIN Management
- **Purpose**: Sets or changes the 4-digit transaction safety PIN.
- **Method**: `POST`
- **Path**: `/set-pin` | `/change-pin`
- **Headers**: `Authorization: Bearer <token>`
- **Request Body (Set)**: `{ "pin": "1234" }`
- **Response**:
```json
{ "success": true, "message": "PIN updated successfully" }
```

---

### 💳 Wallet Module (`/api/wallet`)

#### 1. Get Wallet Balance
- **Purpose**: Retrieves current available and frozen funds.
- **Method**: `GET`
- **Path**: `/`
- **Headers**: `Authorization: Bearer <token>`
- **Response**:
```json
{ "balance": 5000.00, "frozen": 0, "currency": "NGN" }
```

#### 2. Fund Wallet (Initialize)
- **Purpose**: Sets up a Paystack checkout session.
- **Method**: `POST`
- **Path**: `/fund`
- **Request Body**:
```json
{ "amount": 1000, "channels": ["card", "ussd"] }
```
- **Response**:
```json
{ "authorization_url": "...", "reference": "WALLET_..." }
```

#### 3. Verify Funding
- **Purpose**: Manual status check for a funding reference.
- **Method**: `GET`
- **Path**: `/verify?reference=REF_ID`
- **Response**:
```json
{ "status": "success" }
```

---

### 📲 Services Module (`/api/services`)

#### 1. Fetch Service Plans
- **Purpose**: Get dynamic bundle codes/prices for Data, Cable, or Exams.
- **Method**: `GET`
- **Path**: `/plans/:network`
- **Response**:
```json
{ "data": [ { "variation_code": "mtn-100mb", "name": "100MB", "amount": "100" } ] }
```

#### 2. Purchase Airtime
- **Purpose**: Send airtime to a specified number.
- **Method**: `POST`
- **Path**: `/airtime`
- **Request Body**:
```json
{
  "network": "MTN",
  "phone": "08012345678",
  "amount": 200,
  "pin": "1234"
}
```
- **Response**:
```json
{ "message": "Airtime sent successfully", "data": { "ref": "TX123", "status": "success" } }
```

#### 3. Meter Verification
- **Purpose**: Validates meter details before electricity payment.
- **Method**: `POST`
- **Path**: `/electricity/verify/meter`
- **Request Body**: `{ "billersCode": "123456", "serviceID": "ikeja-electric", "type": "prepaid" }`
- **Response**:
```json
{ "data": { "name": "John Doe", "address": "...", "meterNumber": "..." } }
```

---

### 👤 KYC Module (`/api/kyc`)

#### 1. Submit KYC
- **Purpose**: Upload identification for account level upgrade.
- **Method**: `POST`
- **Path**: `/submit`
- **Headers**: `Content-Type: multipart/form-data`
- **Request Body**: `tier`, `documentType`, `documentNumber`, `document` (image file)
- **Response**:
```json
{ "message": "KYC submitted successfully", "data": { "status": "pending" } }
```

#### 2. Process KYC (Admin)
- **Purpose**: Approve or Reject a user's identity submission.
- **Method**: `POST`
- **Path**: `/review/:id`
- **Request Body**: `{ "status": "approved" }`
- **Response**:
```json
{ "message": "KYC approved successfully" }
```

---

### 🎫 Support Module (`/api/support`)

#### 1. Create Support Ticket
- **Purpose**: Report an issue or request assistance.
- **Method**: `POST`
- **Path**: `/create`
- **Request Body**:
```json
{
  "subject": "Payment Delay",
  "message": "My wallet was not credited.",
  "priority": "high",
  "transactionId": "TX123"
}
```
- **Response**:
```json
{ "message": "Support ticket created", "data": { "subject": "Payment Delay" } }
```

---

### 📊 Analytics & Reporting (`/api/analytics`)

#### 1. Revenue Reporting
- **Purpose**: Aggregate successful transaction revenue per day.
- **Method**: `GET`
- **Path**: `/transactions/daily-revenue`
- **Response**: `[ { "_id": "2024-06-03", "totalAmount": 5000 } ]`

---

### 📊 Administrative Tools (`/api/admin`)

#### 1. Filtered Transactions
- **Purpose**: Global audit log of all system transactions.
- **Method**: `GET`
- **Path**: `/transactions`
- **Query Params**: `type`, `status`, `userId`, `startDate`, `endDate`
- **Response**:
```json
{ "success": true, "data": [ { "refId": "...", "amount": 100 } ] }
```

---

### 💸 Withdrawal Module (`/api/withdrawal`)

#### 1. Request Withdrawal
- **Purpose**: Initiate fund payout to bank.
- **Method**: `POST`
- **Path**: `/`
- **Request Body**: `{ "amount": 2000 }`
- **Response**:
```json
{ "message": "Withdrawal request submitted", "request": { "status": "pending" } }
```
- **Notes**: This action freezes funds immediately.

#### 2. Process Payout (Admin)
- **Purpose**: Approve or reject withdrawal and finalize ledger.
- **Method**: `PUT`
- **Path**: `/:id`
- **Request Body**: `{ "status": "approved", "adminNote": "Done" }`
- **Response**:
```json
{ "message": "Withdrawal approved", "request": { "status": "approved" } }
```

---
© 2026 Zantara Fintech Systems. All rights reserved.