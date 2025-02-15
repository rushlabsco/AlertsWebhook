const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const crypto = require('node:crypto');
const nodemailer = require('nodemailer');
require('dotenv').config();
const csv = require('csv-parse');
//const csv = require('csv-parse/sync'); 

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
      .update(rawBody)
      .digest('hex');
    
    return expectedSignature === signature;
  } catch (error) {
    console.error('Signature verification failed:', error);
    return false;
  }
}

// Helper function to capture Razorpay payment
async function captureRazorpayPayment(paymentId, amount, currency) {
  const razorpayKeyId = process.env.RAZORPAY_KEY_ID;
  const razorpayKeySecret = process.env.RAZORPAY_KEY_SECRET;

  try {
    const response = await axios.post(
      `https://api.razorpay.com/v1/payments/${paymentId}/capture`,
      { amount, currency },
      {
        auth: {
          username: razorpayKeyId,
          password: razorpayKeySecret
        },
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

    return response.data;
  } catch (error) {
    console.error('Razorpay capture API error:', error.response ? error.response.data : error.message);
    throw error;
  }
}


async function savePaymentDetails(paymentData) {
  try {
    // First validate that we have the required data
    if (!paymentData?.payload?.payment?.entity?.id) {
      console.error('Invalid payment data structure:', JSON.stringify(paymentData));
      throw new Error('Invalid payment data: missing payment ID');
    }

    const paymentEntity = paymentData.payload.payment.entity;
    const paymentId = paymentEntity.id;

    // Validate paymentId
    if (!paymentId || typeof paymentId !== 'string') {
      console.error('Invalid paymentId:', paymentId);
      throw new Error('Invalid payment ID');
    }

    // Check if the payment is for one of the specific products
    const validProductIds = ['001', '002'];
    const productId = paymentEntity.notes?.productId;
    
    if (!productId || !validProductIds.includes(productId)) {
      console.log('Skipping payment save - not a target product:', productId);
      return true;
    }

    return await db.runTransaction(async (transaction) => {
      // 1. Validate and perform reads
      const paymentRef = db.collection('payments').doc(paymentId.toString());
      const paymentDoc = await transaction.get(paymentRef);
      
      let orderDoc;
      let userDoc;

  
      
      if (paymentEntity.status === 'captured') {
        if (paymentEntity.order_id) {
          const orderRef = db.collection('orders').doc(paymentEntity.order_id.toString());
          orderDoc = await transaction.get(orderRef);
        }
        
        if (paymentEntity.notes?.userId) {
          const userRef2 = db.collection('users').doc(paymentEntity.notes.userId.toString());
          userDoc = await transaction.get(userRef2);
        }
      }

      // 2. Check for existing payment
      if (paymentDoc.exists) {
        console.log('Payment already processed:', paymentId);
        return true;
      }

      // 3. Prepare payment data
      const payment = {
        paymentId: paymentId,
        orderId: paymentEntity.order_id || null,
        amount: paymentEntity.amount / 100,
        currency: paymentEntity.currency || 'INR',
        status: paymentEntity.status,
        method: paymentEntity.method,
        email: paymentEntity.email || null,
        contact: paymentEntity.contact || null,
        notes: paymentEntity.notes || {},
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        metadata: {
          rawResponse: paymentEntity,
          webhookEvent: paymentData.event
        }
      };

      // 4. Perform writes
      try {
        transaction.set(paymentRef, payment);

        if (paymentEntity.status === 'captured') {

          if (orderDoc && orderDoc.exists && paymentEntity.order_id) {
            const orderRef = db.collection('orders').doc(paymentEntity.order_id.toString());
            transaction.update(orderRef, {
              paymentStatus: 'completed',
              paymentId: paymentId,
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
          }

          if (userDoc && userDoc.exists && paymentEntity.notes?.userId) {
            const userRef = db.collection('users').doc(paymentEntity.notes.userId.toString());
            transaction.update(userRef, {
              hasAccess: true,
              accessGrantedAt: admin.firestore.FieldValue.serverTimestamp()
            });
          }
        }

        // After successful transaction, send invite email
        if (paymentEntity.status === 'captured' && paymentEntity.email) {
          try {

            await sendInviteEmail(paymentEntity.email, {
              amount: paymentEntity.amount / 100,
              paymentId: paymentId
            });

          } catch (emailError) {
            // Log email error but don't fail the transaction
            console.error('Failed to send invite email:', emailError);
          }
        }

        return true;
      } catch (writeError) {
        console.error('Transaction write error:', writeError);
        throw writeError;
      }
    });

  } catch (error) {
    console.error('Save payment details error:', error);
    console.error('Payment data:', JSON.stringify(paymentData, null, 2));
    throw error;
  }
}


// Updated webhook endpoint with better error handling
app.post("/Payment", async (req, res) => {
  try {
    console.log('Received webhook:', {
      event: req.body.event,
      headers: req.headers
    });

    const signature = req.headers['x-razorpay-signature'];
    
    if (!signature) {
      console.error('Missing Razorpay signature');
      return res.status(400).json({ error: 'Missing signature' });
    }

    // Verify signature using raw body
    const isValid = verifyRazorpayWebhook(req.rawBody, signature);
    if (!isValid) {
      console.error('Invalid Razorpay signature');
      return res.status(400).json({ error: 'Invalid signature' });
    }

    switch (req.body.event) {
      case 'payment.authorized':
        try {
          // Extract payment details
          const paymentId = req.body.payload.payment.entity.id;
          const amount = req.body.payload.payment.entity.amount;
          const currency = req.body.payload.payment.entity.currency;
          

          // Capture the payment
          const captureResponse = await captureRazorpayPayment(paymentId, amount, currency);
          
          console.log('Payment captured:', captureResponse);

          break;
        } catch (captureError) {
          console.error('Payment capture failed:', captureError);
          // Optionally log the failure or handle it as needed
        }

      case 'payment.captured':

        const email = req.body.payload.payment.entity.email

        console.log(`Processing ${req.body.event} event`);
        await savePaymentDetails(req.body);
        const UserAccess = await updateWorkshopAccess(email);
        console.log('Workshop Access:',UserAccess);
        break;

      case 'payment.failed':
        console.log(`Processing ${req.body.event} event`);
        await savePaymentDetailsFailed(req.body);
        break;
      
      default:
        console.log('Unhandled event type:', req.body.event);
        console.log(req.body);
    }

    return res.status(200).json({ status: 'success' });

  } catch (error) {
    console.error('Webhook processing error:', error);
    return res.status(200).json({ 
      status: 'error logged',
      message: error.message 
    });
  }
});

async function updateWorkshopAccess(email) {
  try {
    // Query for the user document
    const userSnapshot = await db.collection('UserTable')
      .where('Email', '==', email.toString())
      .get();

    // Check if any documents were found
    if (!userSnapshot.empty) {
      // Get the first matching document
      const userDoc = userSnapshot.docs[0];
      
      // Update the document
      await userDoc.ref.update({
        workshopAccess: true
      });
      return "workshopAccess updated to true: " + email;
    } else {
      return "No user found with this email: " + email;
    }
  } catch (error) {
    console.error("Error updating workshop access:", error);
    throw error;
  }
}

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

const SPREADSHEET_ID = '117lxg4P1o3kBIR4TOJSgN-E1pm6WCZEhXQYxJsS1mCc';
const SHEET_ID = 'gid=0';

const fetchGearData = async (req, res) => {
    try {
        // Fetch CSV data from Google Sheets
        const response = await axios.get(
            `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/export?format=csv&gid=${SHEET_ID}`
        );

        // Parse CSV data synchronously
        const records = csv.parse(response.data, {
            columns: true,
            skip_empty_lines: true
        });

        // Process and format the data
        const formattedData = records.map(record => ({
            category: record['Gear category'],
            productName: record['Product name'],
            productLink: record['Product link'],
            recommendedBy: record['Recommended By'],
            notes: record['Notes']
                ? record['Notes']
                    .split('-')
                    .filter(note => note.trim())
                    .map(note => note.trim())
                : []
        })).filter(item => item.category && item.productName);

        // Send the formatted response
        return res.status(200).json({
            success: true,
            data: formattedData
        });

    } catch (error) {
        console.error('Error fetching gear data:', error);
        return res.status(500).json({
            success: false,
            message: 'Error fetching gear data',
            error: error.message
        });
    }
};

// Express route setup
app.get('/hiking-gear', fetchGearData);

module.exports = {
    fetchGearData
};

const signature = crypto
  .createHmac('sha256', 'Shravan')
  .digest('hex');

console.log(signature)

// Email configuration
const transporter = nodemailer.createTransport({
  service: 'gmail', // or your preferred service
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD // Use an app-specific password
  }
});


async function savePaymentDetailsFailed(paymentData) {
  try {
    // First validate that we have the required data
    if (!paymentData?.payload?.payment?.entity?.id) {
      console.error('Invalid payment data structure:', JSON.stringify(paymentData));
      throw new Error('Invalid payment data: missing payment ID');
    }

    const paymentEntity = paymentData.payload.payment.entity;
    const paymentId = paymentEntity.id;

    // Validate paymentId
    if (!paymentId || typeof paymentId !== 'string') {
      console.error('Invalid paymentId:', paymentId);
      throw new Error('Invalid payment ID');
    }

    // Check if the payment is for one of the specific products
    const validProductIds = ['001', '002'];
    const productId = paymentEntity.notes?.productId;
    
    if (!productId || !validProductIds.includes(productId)) {
      console.log('Skipping payment save - not a target product:', productId);
      return true;
    }

    return await db.runTransaction(async (transaction) => {
      // 1. Validate and perform reads
      const paymentRef = db.collection('payments').doc(paymentId.toString());
      const paymentDoc = await transaction.get(paymentRef);
      
      let orderDoc;
      let userDoc;

  
      
      if (paymentEntity.status === 'captured') {
        if (paymentEntity.order_id) {
          const orderRef = db.collection('orders').doc(paymentEntity.order_id.toString());
          orderDoc = await transaction.get(orderRef);
        }
        
        if (paymentEntity.notes?.userId) {
          const userRef2 = db.collection('users').doc(paymentEntity.notes.userId.toString());
          userDoc = await transaction.get(userRef2);
        }
      }

      // 2. Check for existing payment
      if (paymentDoc.exists) {
        console.log('Payment already processed:', paymentId);
        return true;
      }

      // 3. Prepare payment data
      const payment = {
        paymentId: paymentId,
        orderId: paymentEntity.order_id || null,
        amount: paymentEntity.amount / 100,
        currency: paymentEntity.currency || 'INR',
        status: paymentEntity.status,
        method: paymentEntity.method,
        email: paymentEntity.email || null,
        contact: paymentEntity.contact || null,
        notes: paymentEntity.notes || {},
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        metadata: {
          rawResponse: paymentEntity,
          webhookEvent: paymentData.event
        }
      };

      // 4. Perform writes
      try {
        transaction.set(paymentRef, payment);

        if (paymentEntity.status === 'captured') {

          if (orderDoc && orderDoc.exists && paymentEntity.order_id) {
            const orderRef = db.collection('orders').doc(paymentEntity.order_id.toString());
            transaction.update(orderRef, {
              paymentStatus: 'completed',
              paymentId: paymentId,
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
          }

          if (userDoc && userDoc.exists && paymentEntity.notes?.userId) {
            const userRef = db.collection('users').doc(paymentEntity.notes.userId.toString());
            transaction.update(userRef, {
              hasAccess: true,
              accessGrantedAt: admin.firestore.FieldValue.serverTimestamp()
            });
          }
        }

        return true;
      } catch (writeError) {
        console.error('Transaction write error:', writeError);
        throw writeError;
      }
    });

  } catch (error) {
    console.error('Save payment details error:', error);
    console.error('Payment data:', JSON.stringify(paymentData, null, 2));
    throw error;
  }
}

async function sendInviteEmail(email, paymentDetails) {
  // Ensure paymentDetails includes all required fields
  const fullPaymentDetails = {
    amount: paymentDetails.amount,
    paymentId: paymentDetails.paymentId,
    paymentDate: paymentDetails.paymentDate || new Date().toLocaleDateString()
  };

  // Simple plain HTML template
  let emailHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
        }
        .content {
            background: #fff;
            padding: 20px;
        }
        .workshop-title {
            font-size: 18px;
            margin-bottom: 20px;
            font-weight: normal;
        }
        .access-info {
            background: #f7f7f7;
            padding: 15px;
            margin: 15px 0;
        }
        .payment-details {
            margin-top: 20px;
            color: #666;
            background: #f7f7f7;
            padding: 15px;
            margin: 15px 0;
        }
        .signature {
            margin-top: 20px;
        }
        .signature-line {
            border-bottom: 1px solid #ddd;
            margin: 10px 0;
        }
        a {
            color: #000;
            text-decoration: none;
        }
    </style>
</head>
<body>
    <div class="content">
        <p>Hi,</p>
        
        <p>Thank you for purchasing the workshop <a href="https://manav.in/workshop">Growth Blueprint for Hikers</a></p>
        
        <div class="access-info">
            <p><strong>Access:</strong> Login at <a href="https://app.manav.in">app.manav.in</a> to watch the workshop</p>
            <p><strong>Important:</strong> Please use the same email ID that you used for the payment to access the workshop.</p>
        </div>
        
        <div class="signature">
            <p>Keep hiking!</p>
            <p>Manav</p>
            <div class="signature-line"></div>
        </div>

        <div class="payment-details">
            <h3>Payment Details</h3>
            <p>Amount Paid: ₹{paymentDetails.amount}</p>
            <p>Payment ID: {paymentDetails.paymentId}</p>
            <p>Payment Date: {paymentDetails.paymentDate}</p>
        </br>
            <p>For any support, contact me at hi@manav.in</p>
        </div>
        
        
    </div>
</body>
</html>`;

  // Replace placeholders with actual payment details
  emailHtml = emailHtml.replace(/{paymentDetails.amount}/g, fullPaymentDetails.amount)
                       .replace(/{paymentDetails.paymentId}/g, fullPaymentDetails.paymentId)
                       .replace(/{paymentDetails.paymentDate}/g, fullPaymentDetails.paymentDate);

  const emailTemplate = {
    from: process.env.EMAIL_USER,
    to: email,
    subject: 'Access Your Workshop: Growth Blueprint for Hikers',
    html: emailHtml,
    text: '' // Plain text fallback version of the email
  };

  try {
    await transporter.sendMail(emailTemplate);
    console.log('Invite email sent successfully to:', email);
    return true;
  } catch (error) {
    console.error('Error sending invite email:', error);
    throw error;
  }
}
