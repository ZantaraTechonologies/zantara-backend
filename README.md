# Zantara VTU & Fintech Backend

A high-integrity, production-ready VTU & Bill Payment backend built for speed, security, and financial traceability. The system supports Airtime, Data, Electricity, Cable TV, and Exam PINs with integrated Wallet Ledger and KYC enforcement.

---

## 🚀 Core Architecture

The system follows a strict **Layered Architecture** and **Service-Adapter Pattern** to ensure maintainability and vendor flexibility:

-   **Routes**: Express route definitions.
-   **Controllers**: "Thin Controllers" responsible only for request validation and response formatting.
-   **Services**: Core business logic, orchestration, and financial arithmetic.
-   **Adapters**: Abstraction layer for external VTU/Payment providers (Paystack, Monnify, Vas2Nets).
-   **Models**: Mongoose schemas with indexed fields for high-performance querying.

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
**POST** `/register`  
Registers a new user and auto-creates a wallet.
- **Headers**: `Content-Type: application/json`
- **Request Body**: `{ "name": "...", "email": "...", "phone": "...", "password": "..." }`
- **Sample Response**: `{ "success": true, "token": "..." }`

#### 2. User Login
**POST** `/login`  
Authenticates user and returns JWT.
- **Rate Limit**: 5 requests per minute.
- **Sample Response**: `{ "success": true, "token": "..." }`

#### 3. Get Profile
**GET** `/me`  
Retrieves authenticated user data.
- **Auth**: `verifyJWT`

#### 4. Update User info
**PUT** `/users/:id`  
Updates name, phone, or email.

#### 5. Verify Email
**GET** `/verify-email/:token`  
Activates account via email token.

#### 6. PIN Management
- **POST** `/set-pin`: Sets initial 4-digit safety PIN.
- **POST** `/change-pin`: Updates PIN (requires `oldPin`).
- **Sample Request**: `{ "pin": "1234" }`

#### 7. Forgot/Reset Password
- **POST** `/forgot-password`: Sends reset link.
- **PUT** `/reset-password/:token`: Sets new password.

---

### 💳 Wallet & Funding Module (`/api/wallet`)

#### 1. Get Wallet
**GET** `/`  
- **Response**: `{ "balance": 5000, "frozen": 0, "currency": "NGN" }`

#### 2. Fund Wallet
**POST** `/fund`  
Initializes Paystack checkout.
- **Request Body**: `{ "amount": 1000, "channels": ["card"] }`
- **Response**: `{ "authorization_url": "...", "reference": "..." }`

#### 3. Verify Funding
**GET** `/verify?reference=REF`  
Triggers active verification of a reference.

#### 4. Admin Wallet Operations
- **POST** `/credit`: (Admin Only) Ledger-backed manual credit.
- **POST** `/debit`: (Admin Only) Ledger-backed manual debit.

#### 5. Funding Webhooks
- **POST** `/paystack/webhook`: Inbound payment notifications.

---

### 📲 Services Module (`/api/services`)

#### 1. Fetch Plans
**GET** `/plans/:network`  
Returns bundle lists for Data, Cable, or Exams.

#### 2. Purchase Airtime
**POST** `/airtime`  
- **Params**: `network`, `phone`, `amount`, `pin`.

#### 3. Purchase Data
**POST** `/data`  
- **Params**: `serviceID`, `billersCode`, `variation_code`, `phone`, `amount`, `pin`.

#### 4. Electricity Payment
- **POST** `/electricity`: Pay bill.
- **POST** `/electricity/verify/meter`: Validates meter number before payment.

#### 5. Cable TV
**POST** `/cable`  
- **Params**: `serviceID`, `billersCode`, `variation_code`, `amount`, `pin`.

#### 6. Exam PINs
- **POST** `/purchase-pin`: Quantity-based PIN buy.
- **GET** `/purchased-pins`: View inventory of bought PINs.

---

### 👤 KYC Module (`/api/kyc`)

#### 1. Submit KYC
**POST** `/submit`  
Uploads ID documents for verification.
- **Headers**: `multipart/form-data`
- **Fields**: `tier`, `documentType`, `documentNumber`, `document` (image).

#### 2. Admin Review
- **GET** `/all`: List all pending/processed KYC.
- **POST** `/review/:id`: Approve/Reject submission.

---

### 🎫 Support Module (`/api/support`)

#### 1. Management
- **POST** `/create`: Open new ticket.
- **GET** `/my-tickets`: User ticket history.
- **POST** `/reply/:id`: User/Admin conversation reply.
- **POST** `/resolve/:id`: (Admin) Mark ticket as closed.

---

### 📊 Analytics & Reporting (`/api/analytics` | `/api/transaction-logs`)

- **GET** `/daily-transactions`: Success count/revenue per day.
- **GET** `/revenue-per-day`: Financial trend analysis.
- **GET** `/services/top-used`: Provider popularity stats.
- **GET** `/api/transaction-logs/`: (User) Personal history.
- **GET** `/api/transaction-logs/admin/transactions/all`: (Admin) Global history.

---

### 💸 Withdrawal Module (`/api/withdrawal`)

#### 1. Flow
- **POST** `/`: Create request (**Safe Flow**: Freezes funds).
- **GET** `/me`: Personal withdrawal history.
- **PUT** `/:id`: (Admin) Process request (**Safe Flow**: Unfreeze -> Debit).

---

© 2026 Zantara Fintech Systems. All rights reserved.