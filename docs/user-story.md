# User Story: Currency Exchange Platform

## Authentication

### Login
- **Fields**:
    - Email
    - Password

### Register
- **Fields**:
    - First Name
    - Last Name
    - Email
    - Password
    - Password Confirmation
    - WhatsApp Phone Number
    - Country of Origin
    - Country of Residence
    - Purpose: Business, Spending
    - Type of Business: Retail, Industry
    - Monthly Volume:
        - Below $1,000
        - $1,000-$10,000
        - $10,000-$20,000
        - $20,000-$50,000
        - $50,000-$100,000
        - $100,000-$500,000
        - $500,000-$1,000,000
        - Above $1,000,000
    - How did you hear about us? (Friend, Ads)
- **Flow**:
    - "Create Account" button leads to OTP/Email/WhatsApp Confirmation.
    - Upon registration completion, admin dashboard logs user info.

---

## User Dashboard

### Features
- **Main Options**:
    - Send Money
    - Receive Money
- **Additional Information**:
    - Transaction Histories
    - Today’s Exchange Rate
- **Shortcuts**:
    - Dashboard
    - Today’s Rates (Displays same calculator as on the homepage)
    - Transaction History (Displays table of transactions)
    - Logout

---

## Homepage

### Features
- Hero section with headline/animation.
- Sleek currency converter.

---

## Send Money (Example: Nigeria to Kenya)

### Form Fields
1. **Currency Selection**:
    - From Currency: NGN - Nigerian Naira
    - To Currency: KES - Kenyan Shillings
2. **Amount Input**:
    - Input Amount in either NGN or KES (auto-calculates equivalent amount).
3. **Receiver Details**:
    - Bank Name
    - Account Number
    - Account Name
    - For Chinese RMB: Upload Alipay QR Code

### Flow
1. **Preview Page**:
    - Exchange Rate: 10.2
    - Receiver Will Get: 2,500 KES
    - Deposit Amount: 72,000 NGN
    - Payment Instructions:
        - Bank Name
        - Account Number
        - Account Name
        - Note: Rate changes hourly. Make payment and upload receipt immediately.
    - Transaction ID and details are visible in the receipt.
    - **Do Not Include**: Words like "crypto," "usdt," "exchange" in the payment narration.
2. **Payment Partners**:
    - Stripe, Payoneer, Flutterwave, Paystack, Flick.

---

## Receive Money (Example: Kenya to Nigeria)

### Form Fields
1. **Currency Selection**:
    - From Currency: KES - Kenyan Shillings
    - To Currency: NGN - Nigerian Naira
2. **Amount Input**:
    - Input Amount in either KES or NGN (auto-calculates equivalent amount).
    - Allow Undefined Amount (leave input field blank or set to 0).
3. **Your Bank Account Details**:
    - Bank Name
    - Account Number
    - Account Name

### Flow
1. **Preview Page**:
    - Exchange Rate: 10.5
    - Amount to Receive: 68,000 NGN (or Undefined).
    - Sender Payment Instructions:
        - Bank Name: MPesa Kenya
        - Account Number
        - Account Name
        - Note: Rate changes hourly. Make payment and upload receipt immediately.
    - Transaction ID and details are visible in the sender's receipt.
    - **Do Not Include**: Words like "crypto," "usdt," "exchange" in the payment narration.
2. **Payment Partners**:
    - Stripe, Payoneer, Flutterwave, Paystack, Flick.

---

## Admin Functions

### Overview
- View all users.
- Manage payment requests and update payment status.
- View user payment history and screenshots.
- Update exchange rates with a custom admin calculator:
    - Input USDT to all currency rates for send/receive.
    - Input NGN to all currency rates for send/receive.
    - Auto-calculate rates for other currencies.

### Admin Flow

#### Send Money (Example: Naira to Cedis)
1. User fills out the "Send Money" form and uploads payment receipt.
2. Admin receives an email.
3. Admin confirms Naira payment has been received.
    - User receives confirmation email and WhatsApp notification.
4. Admin makes payment into Ghana Cedis account and uploads screenshot.
    - User receives payment completion email and WhatsApp notification.

#### Receive Money (Example: Cedis to Naira)
1. User fills out the "Receive Money" form and uploads payment receipt.
2. Admin receives an email.
3. Admin confirms payment has been received in the Ghana account.
    - User receives confirmation email and WhatsApp notification.
4. Admin settles user in Naira, uploads receipt.
    - User receives email and WhatsApp notification.

### Admin Transactions Table (CSV)
- Columns:
    - Date
    - Customer Name
    - USDT Equivalent
    - Buy - NGN
    - Sell - NGN
    - Profit
    - My GHC Rate
    - Platform USDT Rate
    - Supplier GHC-USDT Rate
- Different currency pairs can have separate sheets or a single consolidated sheet.


## Supported currencies
- RMB (China)
- GHS (Ghana)
- NGN (Nigeria)
- KES (Kenya)
- ZAR (South Africa)
- TZS (Tanzania)
- UGX (Uganda)
- XOF (Benin, Mali, Ivory Coast, Burkina Faso)
- XAF (Cameroon)
- RWF (Rwanda)
- USDT (Crypto)
