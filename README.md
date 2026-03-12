# Zantara VTU & Fintech Backend

A high-integrity, production-ready VTU & Bill Payment backend built for speed, security, and financial traceability. The system supports Airtime, Data, Electricity, Cable TV, and Exam PINs with integrated Wallet Ledger and KYC enforcement.

---

## 🛡️ Fintech Safety & Integrity (The Golden Rules)

This backend is built on five core safety principles mandated for financial operations:

1.  **Zero Direct Mutation**: Wallet balances are never updated directly. All movements MUST go through `WalletService`.
2.  **Ledger-First Architecture**: Every credit, debit, freeze, or refund is recorded in the `WalletLedger`.
3.  **Atomic Sequence**: Financial operations follow a "Debit-First" flow to prevent over-spending even if external APIs fail.
4.  **Webhook Idempotency**: All provider notifications are tracked in `WebhookEvent`.
5.  **Secure PIN & KYC**: Sensitive operations require a hashed 4-digit Transaction PIN.

---

## 📖 API Documentation Reference

### 🔐 Authentication Module (`/api/auth`)

#### 1. Register User
**POST** `/register`  
- **Request Body**: `{ "name": "...", "email": "...", "phone": "...", "password": "..." }`
- **Response**: `{ "success": true, "message": "Registration successful", "token": "..." }`

#### 2. User Login
**POST** `/login`  
- **Response**: `{ "success": true, "token": "..." }`

#### 3. Update User Info
**PUT** `/users/:id`  
- **Response**: `{ "success": true, "data": { "name": "Updated" } }`

#### 4. Email Verification
**GET** `/verify-email/:token`  
- **Response**: `{ "message": "Email verified successfully" }`

#### 5. PIN Management
**POST** `/set-pin` | **POST** `/change-pin`  
- **Response**: `{ "success": true, "message": "PIN updated successfully" }`

---

### 💳 Wallet & Funding Module (`/api/wallet`)

#### 1. Get Wallet Balance
**GET** `/`  
- **Response**: `{ "balance": 5000.00, "frozen": 0, "currency": "NGN" }`

#### 2. Fund Wallet
**POST** `/fund`  
- **Response**: `{ "authorization_url": "...", "reference": "WALLET_..." }`

#### 3. Verify Funding
**GET** `/verify?reference=REF`  
- **Response**: `{ "status": "success" }`

---

### 📲 Services Module (`/api/services`)

#### 1. Fetch Plans
**GET** `/plans/:network`  
- **Response**: `{ "data": [ { "variation_code": "...", "name": "...", "amount": "..." } ] }`

#### 2. Purchase Airtime
**POST** `/airtime`  
- **Response**: `{ "message": "Airtime sent successfully", "data": { "ref": "...", "status": "success" } }`

#### 3. Purchase Data
**POST** `/data`  
- **Response**: `{ "message": "Data purchase successful", "data": { "ref": "...", "status": "success" } }`

#### 4. Electricity Verification
**POST** `/electricity/verify/meter`  
- **Response**: `{ "data": { "name": "John Customer", "meterNumber": "..." } }`

#### 5. Exam PINs
**POST** `/purchase-pin` | **GET** `/purchased-pins`  
- **Response**: `{ "message": "PIN purchased successfully", "data": { "pin": "..." } }`

---

### 👤 KYC Module (`/api/kyc`)

#### 1. Submit KYC
**POST** `/submit` (Form-Data)  
- **Response**: `{ "message": "KYC submitted successfully", "data": { "status": "pending" } }`

#### 2. Review KYC (Admin)
**POST** `/review/:id`  
- **Response**: `{ "message": "KYC approved successfully" }`

---

### 🎫 Support Module (`/api/support`)

#### 1. Create Ticket
**POST** `/create`  
- **Response**: `{ "message": "Support ticket created", "data": { "subject": "..." } }`

#### 2. Reply to Ticket
**POST** `/reply/:id`  
- **Response**: `{ "message": "Reply sent successfully", "data": { "subject": "..." } }`

---

### 📊 Analytics & Reporting (`/api/analytics`)

#### 1. Daily Success count/revenue
**GET** `/transactions/daily`  
- **Response**: `[ { "_id": "2024-06-03", "count": 10, "revenue": 5000 } ]`

#### 2. Revenue Per Day
**GET** `/transactions/daily-revenue`  
- **Response**: `[ { "_id": "2024-06-03", "totalAmount": 5000 } ]`

#### 3. Top Used Services
**GET** `/services/top-used`  
- **Response**: `[ { "_id": "data", "total": 45 } ]`

#### 4. Daily Registrations
**GET** `/users/registrations/daily`  
- **Response**: `[ { "_id": "2024-06-03", "count": 5 } ]`

---

### 📊 Admin Actions (`/api/admin`)

#### 1. Transaction Audit Log
**GET** `/transactions`  
- **Response**: `{ "success": true, "data": [ { "refId": "...", "amount": 100 } ] }`

#### 2. User Management
**GET** `/users`  
- **Response**: `{ "success": true, "data": [ { "name": "...", "email": "..." } ] }`

#### 3. Update User Role/Status
**PUT** `/users/:id`  
- **Response**: `{ "success": true, "data": { "role": "admin" } }`

#### 4. System Settings
**GET** `/settings` | **POST** `/settings`  
- **Response**: `{ "success": true, "message": "Setting updated" }`

---

### 💸 Withdrawal Module (`/api/withdrawal`)

#### 1. User Requests
- **POST** `/`: Request withdrawal (Freezes funds).
- **GET** `/me`: Personal withdrawal history.
- **Response**: `{ "message": "Withdrawal request submitted", "request": { "status": "pending" } }`

#### 2. Admin Processing
- **PUT** `/:id`: Process withdrawal.
- **Response**: `{ "message": "Withdrawal approved", "request": { "status": "approved" } }`

---

© 2026 Zantara Fintech Systems. All rights reserved.