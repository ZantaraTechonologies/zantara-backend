# Zantara VTU & Fintech Backend

A high-integrity, production-ready VTU & Bill Payment backend built for speed, security, and financial traceability. The system supports Airtime, Data, Electricity, Cable TV, and Exam PINs with integrated Wallet Ledger and KYC enforcement.

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

1.  **Zero Direct Mutation**: Wallet balances are never updated directly. All movements MUST go through `WalletService` to ensure a 100% ledger match.
2.  **Ledger-First Architecture**: Every credit, debit, freeze, or refund is recorded in the `WalletLedger` before or during the balance update.
3.  **Atomic Sequence**: Financial operations follow a "Debit-First" flow to prevent over-spending even if external provider APIs fail.
4.  **Webhook Idempotency**: All provider notifications are tracked in `WebhookEvent` to prevent double-crediting.
5.  **Secure PIN & KYC**: Sensitive operations require a hashed 4-digit Transaction PIN. Transaction limits are enforced based on the user's verified KYC Tier.

---

## 🛠️ Features

-   **VTU Services**: Airtime, Data (Dynamic Plans), Electricity (Meter Verify), Cable TV, Exam PINs.
-   **Financials**: Automated Funding (Paystack/Monnify), Manual Credits/Debits, Withdrawal Requests with Fund Freezing.
-   **Security**: JWT Auth, Hashed Passwords/PINs, Multi-tier KYC, Administrative Role-Based Access (RBAC).
-   **Operations**: Support Ticket System, Audit Logging (Activity & Admin Logs), Unified Notification Engine.
-   **Performance**: Paginated admin lists, response compression, and optimized database indexing.

---

## 🔧 Getting Started

### Prerequisites
-   Node.js (v16+)
-   MongoDB (v5+)

### Installation
1.  **Clone & Install**:
    ```bash
    npm install
    ```
2.  **Environment Setup**:
    ```bash
    cp .env.example .env
    # Fill in your DB_URL, JWT_SECRET, and Provider API Keys
    ```
3.  **Development Mode**:
    ```bash
    npm run dev
    ```

---

## 📂 Project Structure
```text
/vtu-backend
├── adapters/       # Provider abstraction layer
├── config/         # Database and app configuration
├── controllers/    # Thin request handlers
├── middlewares/    # Auth, Rate-limiting, Error handling
├── models/         # Database schemas
├── project_docs/   # Audit reports & guides
├── routes/         # API endpoint definitions
├── services/       # Core business logic
└── utils/          # Global helpers & mailers
```

---

## 📖 API Documentation (Overview)

| Module | Base Path | Key Features |
| :--- | :--- | :--- |
| **Auth** | `/api/auth` | Login, Register, Profile, PIN Management |
| **Wallet** | `/api/wallet` | Fund Verify, Balance, Ledger View |
| **Services** | `/api/services` | Airtime, Data, Utility Purchases |
| **Support** | `/api/support` | Ticket Creation, Admin Reply |
| **KYC** | `/api/kyc` | Submission, Admin Review |
| **Admin** | `/api/admin` | User/Transaction Management, Analytics |

---

## 📜 Development Guidelines
-   **Keep Controllers Thin**: Business logic belongs in `/services`.
-   **Use Adapters**: Never call external provider APIs directly from services.
-   **Ledger Compliance**: Always use `WalletService.credit` or `WalletService.debit`.
-   **Response Uniformity**: Use the `sendResponse` utility for all API output.

---
© 2026 Zantara Fintech Systems. All rights reserved.