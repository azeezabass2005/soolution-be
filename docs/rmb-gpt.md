# RMB FLOW

## 1. Currency Selection
- Users can select the currency they want to deal with.
- Available options (for now):
    - **RMB** (active)
    - **GHS** (coming soon)

---

## 2. Exchange Rate & Calculator
- Users can check the exchange rate using the **exchange rate endpoint**.
- They can select their **sending currency** (currently **NGN** or **GHS**) and enter the amount.
- The calculator will display how much they will receive.
- After calculation, users can click **Proceed**.

---

## 3. Payment Modal (Step 1 – Sender Information)
When proceeding, a modal opens with the following fields:

### Alipay Details
- Type of Alipay (Nigerian / Chinese)
- Alipay ID
- Alipay Owner Name
- Upload Alipay QR Code
- Amount (in RMB)
- Sending Currency (NGN or GHS)
    - Approximate converted amount will be displayed

### Sender’s Bank Details
- Account Name
- Bank Name
- Account Number

⚠️ **Note**: The calculator is only for checking rates.  
The modal collects the **actual transaction details**.

- Clicking **Next** will:
    - Save all entered information into the database.

---

## 4. Payment Modal (Step 2 – Transaction Instructions)
- The modal will now display:
    - The amount to send
    - The account number to send money to (our NGN account if user selected NGN, or our GHS account if GHS)

### User Actions
- Upload their **payment receipt**
- Click **I’ve Paid**

On submission:
- The backend will notify our agent via **email** and **WhatsApp** with the uploaded receipt + saved transaction details.

---

## 5. Transactions Table
A table will list all user transactions with **statuses**:
1. **Pending Input** – User entered info but has not uploaded receipt
2. **Awaiting Confirmation** – User uploaded receipt but payment not yet confirmed
3. **Processing** – Payment confirmed but Alipay account not credited yet
4. **Completed** – Payment confirmed, Alipay credited

### Transaction Details View
- **Pending Input** → Shows account number to send money to
- **Awaiting Confirmation** → Shows summary + “Payment awaiting confirmation”
- **Processing** → Shows summary + receipt available for download
- **Completed** → Finalized transaction

---

## 6. Admin Dashboard Flow
- Admins get notified (email + WhatsApp) when a user clicks **I’ve Paid**.

### Admin Actions
1. Review details & mark payment as **Confirmed** if valid
2. Pay into the user’s Alipay account
3. Upload their own payment receipt (screenshot) as proof
4. Mark the transaction as **Completed**  
