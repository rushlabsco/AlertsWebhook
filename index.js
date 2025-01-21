const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const crypto = require('node:crypto');
require('dotenv').config();

const admin = require('firebase-admin');
const serviceAccount = {
  type: process.env.FIREBASE_TYPE,
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: process.env.FIREBASE_AUTH_URI,
  token_uri: process.env.FIREBASE_TOKEN_URI,
  auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_CERT_URL,
  client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL,
  universe_domain: process.env.FIREBASE_UNIVERSE_DOMAIN
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const app = express();

// Important: Use raw body parser for webhook signature verification
app.use(bodyParser.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

// Verify Razorpay webhook signature
function verifyRazorpayWebhook(rawBody, signature) {
  try {
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
      //.update(rawBody)
      .digest('hex');
    
    return expectedSignature === signature;
  } catch (error) {
    console.error('Signature verification failed:', error);
    return false;
  }
}

// Save payment details to Firestore
async function savePaymentDetails(paymentData) {
  const paymentEntity = paymentData.payload.payment.entity;
  const paymentId = paymentEntity.id;

  try {
    return await db.runTransaction(async (transaction) => {
      // 1. First, perform ALL reads
      const paymentRef = db.collection('payments').doc(paymentId);
      const paymentDoc = await transaction.get(paymentRef);
      
      let orderDoc;
      let userDoc;
      
      // Read order document if payment is captured
      if (paymentEntity.status === 'captured') {
        const orderRef = db.collection('orders').doc(paymentEntity.order_id);
        orderDoc = await transaction.get(orderRef);
        
        // Read user document if userId exists in notes
        if (paymentEntity.notes && paymentEntity.notes.userId) {
          const userRef = db.collection('users').doc(paymentEntity.notes.userId);
          userDoc = await transaction.get(userRef);
        }
      }

      // 2. Check conditions
      if (paymentDoc.exists) {
        console.log('Payment already processed:', paymentId);
        return true;
      }

      // 3. Now perform ALL writes
      const payment = {
        paymentId: paymentId,
        orderId: paymentEntity.order_id,
        amount: paymentEntity.amount / 100,
        currency: paymentEntity.currency,
        status: paymentEntity.status,
        method: paymentEntity.method,
        email: paymentEntity.email,
        contact: paymentEntity.contact,
        notes: paymentEntity.notes || {},
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        metadata: {
          rawResponse: paymentEntity,
          webhookEvent: paymentData.event
        }
      };

      // Write payment document
      transaction.set(paymentRef, payment);

      // Update order if payment is captured and order exists
      if (paymentEntity.status === 'captured' && orderDoc && orderDoc.exists) {
        const orderRef = db.collection('orders').doc(paymentEntity.order_id);
        transaction.update(orderRef, {
          paymentStatus: 'completed',
          paymentId: paymentId,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      // Update user if userId exists and user document exists
      if (paymentEntity.notes?.userId && userDoc && userDoc.exists) {
        const userRef = db.collection('users').doc(paymentEntity.notes.userId);
        transaction.update(userRef, {
          hasAccess: true,
          accessGrantedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      return true;
    });

  } catch (error) {
    console.error('Error saving payment details:', error);
    throw error;
  }
}


// Webhook endpoint
app.post("/razorpay-webhook", async (req, res) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    
    if (!signature) {
      return res.status(400).json({ error: 'Missing signature' });
    }

    // Verify signature using raw body
    const isValid = verifyRazorpayWebhook(req.rawBody, signature);
    if (!isValid) {
      return res.status(400).json({ error: 'Invalid signature' });
    }

    // Handle different payment events
    switch (req.body.event) {
      case 'payment.captured':
        await savePaymentDetails(req.body);
        break;
      
      case 'payment.failed':
        // Handle failed payments if needed
        await savePaymentDetails(req.body);
        break;
      
      default:
        console.log('Unhandled event type:', req.body.event);
    }

    // Always return 200 quickly to acknowledge receipt
    res.status(200).json({ status: 'success' });

  } catch (error) {
    console.error('Webhook processing error:', error);
    // Still return 200 to prevent retries, but log the error
    res.status(200).json({ status: 'error logged' });
  }
});


async function logToFirestore(logData) {
  try {
    // Ensure all required fields are defined
    if (!logData.phone_number_id || !logData.wa_id || !logData.message_id || !logData.timestamp) {
      console.error("Log data is missing required fields:", logData);
      return;
    }

    await db.collection("webhook-logs").add({
      phone_number_id: logData.phone_number_id,
      wa_id: logData.wa_id,
      message_id: logData.message_id,
      timestamp: logData.timestamp, // Ensure this is defined
      timestampStored: admin.firestore.FieldValue.serverTimestamp()
    });
    console.log("Relevant log stored in Firestore:", logData);
  } catch (error) {
    console.error("Error storing log in Firestore:", error);
  }
}

const port = process.env.PORT || 3000;  // Use 3000 as a default if PORT is not set
app.listen(port, () => {
  console.log(`Webhook is listening on port ${port}`);
});

app.all("/webhook", async (req, res) => {


  if (req.method === "GET") {
    let mode = req.query["hub.mode"];
    let challange = req.query["hub.challenge"];
    let token = req.query["hub.verify_token"];

    if (mode && token) {
      if (mode === "subscribe" && token === mytoken) {
        res.status(200).send(challange);
      } else {
        res.status(403);
      }

    }
  }

  if (req.method === "POST") {
    let body_param = req.body;

    if (
      body_param.entry &&
      body_param.entry[0].changes &&
      body_param.entry[0].changes[0].value.messages &&
      body_param.entry[0].changes[0].value.messages[0].button &&
      body_param.entry[0].changes[0].value.messages[0].button.payload === "Yes, I'm Back & Safe"
    ) {
      const messageData = body_param.entry[0].changes[0].value.messages[0];
      const contextId = messageData.context ? messageData.context.id : messageData.id;
      console.log("Sending Id", contextId);
      console.log("Message From Number", messageData.from);
      const ref = await db.collection('WhatsAppLog').doc(contextId).get();
      if (ref.exists) {
        // Extract the alertTableId from the document
        const alertTableId = ref.data().alertTableId;
        const alertTableRef = await db.collection('AlertTable').doc(alertTableId).get();
        const alertData = alertTableRef.data();
        const userId = alertData.UserId;
        const userTableRef = await db.collection('UserTable').doc(userId).get();
        const userData = userTableRef.data();
        const userName = userData.FullName;
        const trip = alertData.TripName;
        const updateData = {
          BackAndSafeTime: new Date(),
          IsTripCompleted: true
        };
        await db.collection('AlertTable').doc(alertTableId).update(updateData);
        const response = await axios.post(
          process.env.FACEBOOK_GRAPH_API_URL,
          {
            messaging_product: "whatsapp",
            to: messageData.from, // Replace with the actual recipient phone number
            type: "template",
            template: {
              name: "safe_return_confirmation_beta2",
              language: {
                code: "en"
              },
              components: [
                {
                  type: "body",
                  parameters: [
                    {
                      type: "text",
                      text: userName
                    },
                    {
                      type: "text",
                      text: trip
                    }
                  ]
                }
              ]
            }
          },
          {
            headers: {
              Authorization: `Bearer ${process.env.FACEBOOK_GRAPH_API_TOKEN}`,
              'Content-Type': 'application/json'
            }
          }
        );
        console.log('Message sent:', response.data);
        console.log('AlertTable updated successfully');
      } else {
        console.log('No document found in WhatsAppLog');
      }
    }
    res.sendStatus(200);
  } else {
    res.sendStatus(405).send("Method Not Allowed");
  }
});


app.get("/", (req, res) => {
  res.status(200).send("Hello, this is webhook setup");
});

const signature = crypto
  .createHmac('sha256', 'Shravan')
  .digest('hex');

console.log(signature)