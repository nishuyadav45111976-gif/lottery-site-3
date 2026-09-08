# WhatsApp Personal-Record Inbox

This project now contains a neutral WhatsApp webhook inbox for personal records. It stores incoming text messages and parses category/entry/amount fields for review; it does not create financial or betting transactions.

Required production environment variables:
- WHATSAPP_VERIFY_TOKEN — arbitrary secret used for Meta webhook verification
- WHATSAPP_APP_SECRET — Meta app secret used to verify x-hub-signature-256

The official WhatsApp Business Platform access token/phone-number configuration can be added later if outbound acknowledgements are enabled.

Webhook verification endpoint: `/api/whatsapp/webhook`
Webhook POST endpoint: `/api/whatsapp/webhook`

Admin: `/admin/whatsapp`
