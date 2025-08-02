const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const crypto = require('node:crypto');
const nodemailer = require('nodemailer');
require('dotenv').config();
//const csv = require('csv-parse');
const csv = require('csv-parse/sync'); 
const cors = require("cors");
const slugify = require('slugify');
const { Client, APIErrorCode, ClientErrorCode } = require('@notionhq/client');

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

// --- Google Sheets & Payment Confirmation Logic ---
const { google } = require('googleapis');

const db = admin.firestore();
const app = express();
app.use(cors()); 
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

    if (paymentData.payload.payment.entity.email) {
      const email = paymentData.payload.payment.entity.email
      console.log(email);
      const UserAcess = await updateWorkshopAccess(email);
      console.log(UserAcess);
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
          const email = req.body.payload.payment.entity.email;
          const productId = req.body.payload.payment.entity.notes?.productId;

          // Capture the payment
          const captureResponse = await captureRazorpayPayment(paymentId, amount, currency);
          console.log('Payment captured:', captureResponse);

          // If productId is 003, handle sheets and email flow
          if (productId === '003') {
            try {
              // Prepare payment data for Google Sheet
              const paymentData = {
                paymentId,
                userEmail: email,
                amount: amount / 100, // Convert from paise to rupees
                timestamp: new Date().toISOString(),
                productName: 'Growth Blueprint for Hikers' // Hardcoded since this is specific to productId 003
              };

              // Append to Google Sheet
              await appendToGoogleSheet(paymentData);

              // Send confirmation email
              if (email) {
                await sendPaymentConfirmationEmail(email, {
                  amount: amount / 100,
                  paymentId: paymentId,
                  productName: 'Growth Blueprint for Hikers'
                });
              }
            } catch (error) {
              console.error('Error in payment confirmation flow:', error);
              // Don't throw error to avoid affecting payment capture
            }
          }

          break;
        } catch (captureError) {
          console.error('Payment capture failed:', captureError);
          // Handle capture error
        }

      case 'payment.captured':

        //const email = req.body.payload.payment.entity.email

        console.log(`Processing ${req.body.event} event`);
        await savePaymentDetails(req.body);
        // const UserAccess = await updateWorkshopAccess(email);
        // console.log('Workshop Access:',UserAccess);
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
// app.listen(port, () => {
//   console.log(`Webhook is listening on port ${port}`);
// });

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

//https://docs.google.com/spreadsheets/d/1BoZftPH5EAj29xLPrKcAZ_F7i1jYC9V6-BZDhMHeRm8/edit?usp=sharing
const SPREADSHEET_ID = '1BoZftPH5EAj29xLPrKcAZ_F7i1jYC9V6-BZDhMHeRm8';
const SHEET_ID = '0';

const fetchGearData = async (req, res) => {
  try {
      const response = await axios.get(
          `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq?tqx=out:csv&sheet=${SHEET_ID}`,
          {
              headers: {
                  'Accept': 'text/csv'
              }
          }
      );
      const records = csv.parse(response.data, {
          columns: true,
          skip_empty_lines: true,
          from_line: 2 
      });
      
      const formattedData = records.map(record => ({
          broadCategory: record['Category'],
          productName: record['Product name'],
          productLink: record['Product link'],
          productImage: record['Product Image'],
          recommendedBy: record['Your Name'],
          notes: record['Notes\n(optional)']
              ? record['Notes\n(optional)']
                  .split('\n') 
                  .filter(note => note.trim())
                  .map(note => note.trim())
              : []
      })).filter(item => item.broadCategory && item.productName); // Changed from category to broadCategory

      // console.log(formattedData);

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


//////////////////////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////

function validateConfig() {
    const required = ['NOTION_TOKEN', 'NOTION_DATABASE_ID'];
    const missing = required.filter(key => !process.env[key]);
    if (missing.length > 0) {
        console.error(`❌ Missing required environment variables: ${missing.join(', ')}`);
        console.error("   Please ensure they are set in your .env file or environment.");
        process.exit(1);
    }
}
validateConfig();

// --- Notion Client Setup ---
const notion = new Client({
    auth: process.env.NOTION_TOKEN,
    notionVersion: '2022-06-28',
});
const databaseId = process.env.NOTION_DATABASE_ID;

// --- Helper Functions ---

/**
 * Extracts plain text from a Notion rich text array.
 */
function getPlainTextFromRichTextArray(richTextArray) {
    if (!richTextArray || !Array.isArray(richTextArray)) return '';
    return richTextArray.map(rt => rt.plain_text).join('');
}

/**
 * Extracts the usable value from a Notion property object.
 * Handles various property types.
 */
function getPropertyValue(property) {
    if (!property) return null;
    try {
        switch (property.type) {
            case 'title':
                return property.title || []; // Returns array of rich text objects
            case 'rich_text':
                return property.rich_text || []; // Returns array of rich text objects
            case 'number':
                return property.number;
            case 'select':
                return property.select?.name || null;
            case 'multi_select':
                return property.multi_select?.map(s => s.name) || [];
            case 'status':
                return property.status?.name || null;
            case 'date':
                return property.date ? { start: property.date.start, end: property.date.end || null } : null;
            case 'files':
                return property.files?.map(f => ({
                    name: f.name,
                    url: f.file?.url || f.external?.url || null,
                })) || [];
            case 'checkbox':
                return property.checkbox;
            case 'url':
                return property.url;
            case 'email':
                return property.email;
            case 'phone_number':
                return property.phone_number;
            case 'people':
                return property.people?.map(p => ({ id: p.id, name: p.name })) || [];
            case 'relation':
                return property.relation?.map(r => r.id) || [];
            case 'unique_id':
                const prefix = property.unique_id?.prefix;
                const number = property.unique_id?.number;
                if (number === null || number === undefined) return null;
                return prefix ? `${prefix}-${number}` : `${number}`;
            case 'formula':
                switch (property.formula?.type) {
                    case 'string': return property.formula.string;
                    case 'number': return property.formula.number;
                    case 'boolean': return property.formula.boolean;
                    case 'date': return property.formula.date ? { start: property.formula.date.start, end: property.formula.date.end || null } : null;
                    default: return null;
                }
            case 'rollup':
                switch (property.rollup?.type) {
                    case 'number': return property.rollup.number;
                    case 'date': return property.rollup.date ? { start: property.rollup.date.start, end: property.rollup.date.end || null } : null;
                    case 'array':
                        return property.rollup.array?.map(item => getPropertyValue(item)).filter(item => item !== null) || [];
                    default: return null;
                }
            case 'created_time':
                return property.created_time;
            case 'last_edited_time':
                return property.last_edited_time;
            case 'created_by':
                return { id: property.created_by?.id };
            case 'last_edited_by':
                return { id: property.last_edited_by?.id };
            default:
                return `Unsupported type: ${property.type}`;
        }
    } catch (error) {
        console.error(`[getPropertyValue] Error processing property type ${property?.type} for property ID ${property?.id}:`, error);
        return null;
    }
}

/**
 * Generates a URL-friendly slug from a string.
 */
function generateSlug(text) {
    if (!text) return null;
    return slugify(text, {
        lower: true,
        strict: true,
        remove: /[*+~.()'"!:@]/g
    });
}

const slugTracker = {
    usedSlugs: new Map(),
    getUniqueSlug: function(baseSlug) {
        if (!baseSlug) return null;
        let count = this.usedSlugs.get(baseSlug) || 0;
        let finalSlug = baseSlug;
        if (count > 0) {
            finalSlug = `${baseSlug}-${count}`;
        }
        this.usedSlugs.set(baseSlug, count + 1);
        return finalSlug;
    },
    reset: function() {
        this.usedSlugs.clear();
    }
};

/**
 * Simplifies a Notion block object to a more usable structure.
 */
function simplifyBlock(block) {
    if (!block || !block.type) return null;

    const simplified = {
        id: block.id,
        type: block.type,
        has_children: block.has_children,
        content: null,
    };

    try {
        const blockContent = block[block.type];
        if (!blockContent && block.type !== 'divider' && block.type !== 'breadcrumb') { // Some blocks have no content by design
             // Allow blocks like 'divider' or 'breadcrumb' which might not have blockContent
            if (block.type !== 'divider' && block.type !== 'breadcrumb' && block.type !== 'column_list' && block.type !== 'column' && block.type !== 'table_of_contents') {
                 console.warn(`[simplifyBlock] Block type ${block.type} (ID: ${block.id}) has no content object (block[block.type] is undefined/null).`);
                 // return simplified; // or return null if such blocks are not useful
            }
        }


        switch (block.type) {
            case 'paragraph':
            case 'heading_1':
            case 'heading_2':
            case 'heading_3':
            case 'bulleted_list_item':
            case 'numbered_list_item':
            case 'quote':
            case 'toggle':
            case 'callout':
            case 'to_do':
                simplified.content = blockContent.rich_text || [];
                if (block.type.startsWith('heading_')) {
                    simplified.level = parseInt(block.type.split('_')[1], 10);
                }
                if (block.type === 'callout' && blockContent.icon) {
                    const iconDetails = blockContent.icon;
                    if (iconDetails) {
                        simplified.icon = iconDetails.emoji || (iconDetails[iconDetails.type] ? iconDetails[iconDetails.type].url : null) || null;
                    }
                }
                if (block.type === 'to_do') {
                    simplified.checked = blockContent.checked;
                }
                break;

            case 'image':
                simplified.content = {
                    url: blockContent.file?.url || blockContent.external?.url || null,
                    caption: blockContent.caption || [],
                };
                break;
            case 'video':
                simplified.content = {
                    url: blockContent.external?.url || blockContent.file?.url || null,
                    caption: blockContent.caption || [],
                };
                break;
            case 'file':
                 // Use blockContent directly for name and caption
                const fileName = blockContent.name || getPlainTextFromRichTextArray(blockContent.caption) || 'File';
                simplified.content = {
                    name: fileName,
                    url: blockContent.file?.url || blockContent.external?.url || null,
                    caption: blockContent.caption || [],
                };
                break;
            case 'audio':
                simplified.content = {
                    url: blockContent.file?.url || blockContent.external?.url || null,
                    caption: blockContent.caption || [],
                };
                break;

            case 'code':
                simplified.content = {
                    language: blockContent.language || 'plaintext',
                    text: blockContent.rich_text?.map(rt => rt.plain_text).join('\n') || '',
                    caption: blockContent.caption || [],
                };
                break;

            case 'embed':
            case 'link_preview':
            case 'bookmark':
                simplified.content = {
                    url: blockContent.url,
                    caption: blockContent.caption || [],
                };
                break;

            case 'divider':
                simplified.content = {};
                break;
            case 'child_page':
                simplified.content = { title: blockContent.title || 'Untitled Child Page' };
                break;
            case 'child_database':
                simplified.content = { title: blockContent.title || 'Untitled Child Database' };
                break;
            case 'synced_block':
                 // Check if synced_from exists
                const syncedFrom = block.synced_block?.synced_from;
                simplified.content = { 
                    synced_from: syncedFrom ? syncedFrom.block_id : 'original' 
                };
                // If it's an original synced block, it might contain children which are not directly part of blockContent here.
                // The children would be fetched if has_children is true.
                // If it's a reference, blockContent might be undefined.
                // If block.synced_block.children exists (for original), you might want to process them here or let the recursive fetch handle it.
                // For simplicity, we only store the source. The actual content of a synced block needs to be fetched recursively if has_children.
                // If it's a reference (synced_from is not null), has_children will be false for the reference block itself.
                break;
            case 'table_of_contents':
                simplified.content = { color: blockContent.color };
                break;
            case 'breadcrumb':
                simplified.content = {};
                break;
            case 'column_list':
            case 'column':
                simplified.content = {}; // Children (columns or content within columns) are fetched separately
                break;
            case 'equation':
                simplified.content = { expression: blockContent.expression };
                break;
            case 'table':
                simplified.content = {
                    has_column_header: blockContent.has_column_header,
                    has_row_header: blockContent.has_row_header,
                };
                break;
            case 'table_row':
                simplified.content = { cells: blockContent.cells.map(cellRichTextArray => cellRichTextArray || []) };
                break;

            case 'template':
            case 'link_to_page':
            case 'unsupported':
                return null;

            default:
                simplified.content = { raw: blockContent, message: `Unhandled block type: ${block.type}` };
                break;
        }
    } catch (error) {
        console.error(`[simplifyBlock] Error processing block type ${block?.type} (ID: ${block?.id}):`, error);
        simplified.content = { error: "Failed to process block content" };
    }
    return simplified;
}

// --- Notion API Interaction Functions ---
async function getDatabasePages(filter = undefined, sorts = undefined) {
    try {
        const response = await notion.databases.query({
            database_id: databaseId,
            filter: filter,
            sorts: sorts,
        });
        return response.results;
    } catch (error) {
        console.error('❌ Error querying Notion Database:', error.body || error);
        if (error.code === APIErrorCode.ObjectNotFound) {
            console.error(`   Database with ID "${databaseId}" not found or integration lacks permissions.`);
        } else if (error.code === APIErrorCode.Unauthorized) {
            console.error(`   Invalid or unauthorized Notion token.`);
        } else if (error.code === APIErrorCode.RateLimited) {
            console.error(`   Hit Notion API rate limit. Retrying might be needed.`);
        } else if (error.code === ClientErrorCode.RequestTimeout) {
            console.error(`   Notion API request timed out.`);
        }
        throw error;
    }
}

async function getPageBlocks(pageId) {
    const blocks = [];
    let cursor = undefined;
    let hasMore = true;
    console.log(`   Fetching blocks for page ID: ${pageId}`);
    while (hasMore) {
        try {
            const response = await notion.blocks.children.list({
                block_id: pageId,
                start_cursor: cursor,
                page_size: 100,
            });
            blocks.push(...response.results);
            cursor = response.next_cursor;
            hasMore = response.has_more;
        } catch (error) {
            console.error(`❌ Error fetching blocks chunk for page ${pageId}:`, error.body || error);
            hasMore = false;
        }
    }
    console.log(`   Finished fetching blocks for ${pageId}. Total blocks: ${blocks.length}`);
    return blocks;
}

// --- Global Cache ---
let TRAIL_CACHE = {
    list: null,
    details: {},
    lastFetchedList: 0,
    lastFetchedDetails: {},
};
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Add this near your other cache declarations
const SLUG_MAP_CACHE = {
    map: new Map(),
    lastUpdated: 0
};

app.use(cors());
// const PORT = process.env.PORT || 3000;
app.use(express.json());

// --- API Endpoints ---

// Add this function after your other helper functions
async function getOrCreateSlugMap() {
    const now = Date.now();
    if (SLUG_MAP_CACHE.map.size > 0 && (now - SLUG_MAP_CACHE.lastUpdated < CACHE_TTL)) {
        return SLUG_MAP_CACHE.map;
    }

    console.log("Rebuilding slug map...");
    const pages = await getDatabasePages();
    const slugMap = new Map();
    
    // First pass: generate base slugs
    const baseSlugCounts = new Map();
    pages.forEach(page => {
        const titleRichText = getPropertyValue(page.properties['Trail Name']);
        const titlePlainText = getPlainTextFromRichTextArray(titleRichText);
        const baseSlug = generateSlug(titlePlainText);
        baseSlugCounts.set(baseSlug, (baseSlugCounts.get(baseSlug) || 0) + 1);
    });

    // Second pass: generate unique slugs
    pages.forEach(page => {
        const titleRichText = getPropertyValue(page.properties['Trail Name']);
        const titlePlainText = getPlainTextFromRichTextArray(titleRichText);
        const baseSlug = generateSlug(titlePlainText);
        
        let finalSlug = baseSlug;
        if (baseSlugCounts.get(baseSlug) > 1) {
            const count = slugMap.size;
            finalSlug = `${baseSlug}-${count + 1}`;
        }
        
        slugMap.set(page.id, finalSlug);
        slugMap.set(finalSlug, page.id);
    });

    SLUG_MAP_CACHE.map = slugMap;
    SLUG_MAP_CACHE.lastUpdated = now;
    return slugMap;
}

// Modify the /trails endpoint to use the slug map
app.get('/trails', async (req, res) => {
    console.log("➡️ GET /trails");
    const now = Date.now();

    if (TRAIL_CACHE.list && (now - TRAIL_CACHE.lastFetchedList < CACHE_TTL)) {
        console.log("   Serving from cache.");
        return res.json(TRAIL_CACHE.list);
    }

    console.log("   Fetching fresh data from Notion...");
    try {
        const pages = await getDatabasePages();
        const slugMap = await getOrCreateSlugMap();

        const trailList = pages
            .map(page => {
                const titleRichText = getPropertyValue(page.properties['Trail Name']);
                const titlePlainText = getPlainTextFromRichTextArray(titleRichText);
                const tags = getPropertyValue(page.properties['Documentation Status']) || [];
                
                // Only include if the trail has the "complete" tag
                if (!tags.includes('Live')) {
                    return null;
                }

                return {
                    id: page.id,
                    title: titlePlainText || 'Untitled',
                    slug: slugMap.get(page.id)
                };
            })
            .filter(trail => trail !== null && trail.title !== 'Untitled');

        TRAIL_CACHE.list = trailList;
        TRAIL_CACHE.lastFetchedList = now;
        console.log(`   Cached trail list with ${trailList.length} complete trails.`);
        console.log(`✅ Successfully processed ${trailList.length} complete trails for list.`);
        res.json(trailList);
    } catch (err) {
        console.error('❌ Error in /trails endpoint:', err);
        res.status(500).json({ error: 'Failed to fetch trail list from Notion' });
    }
});

// Modify the /trails/:identifier endpoint
app.get('/trails/:identifier', async (req, res) => {
    const { identifier } = req.params;
    console.log(`➡️ GET /trails/${identifier}`);
    const now = Date.now();

    const cachedData = TRAIL_CACHE.details[identifier];
    const lastFetched = TRAIL_CACHE.lastFetchedDetails[identifier];
    if (cachedData && lastFetched && (now - lastFetched < CACHE_TTL)) {
        console.log(`   Serving trail "${identifier}" from cache.`);
        return res.json(cachedData);
    }
    console.log(`   Cache miss or expired for "${identifier}". Fetching fresh data...`);

    try {
        const slugMap = await getOrCreateSlugMap();
        
        // If identifier is a slug, get the page ID from slug map
        const pageId = slugMap.get(identifier) || identifier;

        let page = null;
        let filter = null;
        const isUuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(pageId);

        if (isUuid) {
            try {
                console.log(`   Identifier looks like a Page ID. Attempting direct retrieve...`);
                page = await notion.pages.retrieve({ page_id: pageId });
                console.log(`   Direct retrieve successful for ID: ${pageId}`);
            } catch (directError) {
                console.warn(`   Direct retrieve failed for ID "${pageId}", falling back to database query. Error:`, directError.code || directError.message);
            }
        }

        if (!page) {
            console.log(`   Querying database to find identifier: "${pageId}"`);
            const potentialTrailIdNumPart = parseInt(pageId.split('-').pop(), 10);

            if (!isNaN(potentialTrailIdNumPart) && pageId.includes('-')) {
                console.log(`   Identifier seems like a Unique ID (e.g., PREFIX-123). Filtering database by 'Trail ID' (number part)...`);
                filter = {
                    property: 'Trail ID', // Name of your Unique ID property
                    unique_id: { equals: potentialTrailIdNumPart }
                };
            } else {
                console.log(`   Identifier seems like a slug. Will fetch all and match slug.`);
                filter = undefined; // Fetch all to filter by generated slug later
            }

            const pages = await getDatabasePages(filter);
            console.log(`   Database query returned ${pages.length} potential matches.`);

            if (filter && pages.length > 0) { // If filtered by Unique ID
                page = pages[0];
            } else if (!filter) { // If matching by slug
                slugTracker.reset(); // Reset for accurate slug generation in this context
                const pagesWithSlugs = pages.map(p => {
                    const titleRichText = getPropertyValue(p.properties['Trail Name']);
                    const titlePlainText = getPlainTextFromRichTextArray(titleRichText);
                    const baseSlug = generateSlug(titlePlainText);
                    const uniqueSlug = slugTracker.getUniqueSlug(baseSlug || p.id); // Use page.id as fallback for slug base
                    return { page: p, slug: uniqueSlug, titlePlainText: titlePlainText };
                });
                const matchingPageEntry = pagesWithSlugs.find(pws => pws.slug === pageId);
                if (matchingPageEntry) {
                    page = matchingPageEntry.page;
                }
            }
        }

        if (!page) {
            console.log(`   ❌ Trail with identifier "${pageId}" not found.`);
            return res.status(404).json({ error: `Trail not found: ${pageId}` });
        }
        
        const pageTitleForLog = getPlainTextFromRichTextArray(getPropertyValue(page.properties['Trail Name'])) || 'N/A';
        console.log(`   Found page: ${page.id} (Title: ${pageTitleForLog})`);


        const rawProps = page.properties;
        const hikeNameRichText = getPropertyValue(rawProps['Trail Name']);
        const hikeNamePlainText = getPlainTextFromRichTextArray(hikeNameRichText);

        const props = {
            hikeName: hikeNamePlainText,
            hikeNameRichText: hikeNameRichText,
            lastUpdated: getPropertyValue(rawProps['Last edited time']),
            lastUpdatedManually:getPropertyValue(rawProps['Last Verified Date (Manual)'])?.start,
            state: getPropertyValue(rawProps['State']), // Assuming this returns string or null
            alternateName: getPlainTextFromRichTextArray(getPropertyValue(rawProps['Alternate Name(s)'])), // Process as rich text
            alternateNameRichText: getPropertyValue(rawProps['Alternate Name(s)']), // Keep rich text
            maxAltitude: getPropertyValue(rawProps['Max Alt (m)']),
            gainAscent: getPropertyValue(rawProps['Total Ascent (m)']),
            distance: getPropertyValue(rawProps['Distance (kms)']),
            durationTraditional: getPropertyValue(rawProps['Duration (Traditional)']),
            durationSpeedHike: getPropertyValue(rawProps['Duration (Speed Hike)']),
            popularity: getPropertyValue(rawProps['Popularity']),
            surface: getPropertyValue(rawProps['Trail Surface']),
            reliefFeatures: getPropertyValue(rawProps['Relief Features']),
            tags: getPropertyValue(rawProps['General Tags']),
            mapLink: getPropertyValue(rawProps['Waymarked Link']),
            gpxFiles: getPropertyValue(rawProps['GPX']),
            hikingWindow: getPropertyValue(rawProps['Hiking Window']),
            trailId: getPropertyValue(rawProps['Trail ID']),
            district: getPropertyValue(rawProps['District']),
            acclimatizationRequired: getPropertyValue(rawProps['Acclimatization Required']),
            RouteName : getPlainTextFromRichTextArray(getPropertyValue(rawProps['Route'])),
            RouteNameRichText : getPropertyValue(rawProps['Route']),
            FirebaseTrekId : getPropertyValue(rawProps['FirebaseTrekId']),
            Crowd : getPropertyValue(rawProps['Crowd']),
        };
        Object.keys(props).forEach(key => {
            if (props[key] === null || (Array.isArray(props[key]) && props[key].length === 0)) {
                // For rich text fields, an empty array `[]` is a valid "empty" state.
                // Decide if you want to delete empty rich text arrays or keep them.
                // Keeping them might be more consistent for the client.
                // Let's only delete if truly null.
                if (props[key] === null) {
                    delete props[key];
                }
            }
        });

        const rawBlocks = await getPageBlocks(page.id);
        const blocks = rawBlocks.map(simplifyBlock).filter(b => b !== null);

        const responseData = {
            id: page.id,
            title: props.hikeName || 'Untitled',
            titleRichText: props.hikeNameRichText,
            slug: generateSlug(props.hikeName) || page.id,
            properties: props,
            blocks: blocks,
        };

        TRAIL_CACHE.details[identifier] = responseData;
        TRAIL_CACHE.lastFetchedDetails[identifier] = now;
        if (identifier !== page.id) TRAIL_CACHE.details[page.id] = responseData;
        if (identifier !== responseData.slug) TRAIL_CACHE.details[responseData.slug] = responseData;
        TRAIL_CACHE.lastFetchedDetails[page.id] = now;
        TRAIL_CACHE.lastFetchedDetails[responseData.slug] = now;
        console.log(`   Cached details for "${identifier}" (and its ID/slug variants).`);

        console.log(`✅ Successfully processed trail: ${responseData.title}`);
        res.json(responseData);

    } catch (err) {
        console.error(`❌ Error in /trails/${identifier} endpoint:`, err.body || err);
        let statusCode = 500;
        let message = 'Failed to fetch or process trail details from Notion';
        if (err.code === APIErrorCode.ObjectNotFound || err.status === 404) {
            statusCode = 404;
            message = `Trail not found: ${identifier}`;
        } else if (err.code === APIErrorCode.RateLimited) {
            statusCode = 429;
            message = 'Notion API rate limit exceeded. Please try again later.';
        }
        res.status(statusCode).json({ error: message, details: err.code ? err.code : null });
    }
});


/**
 * Appends payment data to a Google Sheet.
 * Assumes the Google Sheet and headers already exist.
 * @param {object} paymentData - The payment data to log.
 */
async function appendToGoogleSheet(paymentData) {
    try {
        const auth = new google.auth.GoogleAuth({
            credentials: {
                client_email: process.env.FIREBASE_CLIENT_EMAIL,
                private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
            },
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });

        const sheets = google.sheets({ version: 'v4', auth });
        const spreadsheetId = process.env.PAYMENT_SPREADSHEET_ID;
        const range = 'Sheet1';

        const values = [
            [
                paymentData.paymentId,
                paymentData.userEmail || 'N/A',
                paymentData.amount,
                paymentData.timestamp,
                paymentData.productName
            ],
        ];

        await sheets.spreadsheets.values.append({
            spreadsheetId,
            range,
            valueInputOption: 'USER_ENTERED',
            resource: { values },
        });
        console.log('Payment data successfully appended to Google Sheet.');
    } catch (error) {
        console.error('Error writing to Google Sheet:', error.message || error);
        throw new Error('Failed to save data to Google Sheet.');
    }
}

/**
 * Sends a payment confirmation email.
 * @param {string} userEmail - The recipient's email address.
 * @param {object} details - Details for the email template.
 */
async function sendPaymentConfirmationEmail(userEmail, details) {
    const emailHtml = `
    <!DOCTYPE html>
    <html>
    <head>
        <style>
            body { font-family: Arial, sans-serif; }
            .container { max-width: 600px; margin: auto; padding: 20px; border: 1px solid #ddd; }
            .header { font-size: 24px; color: #333; }
            .details { margin: 20px 0; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1 class="header">Your Spot is Confirmed!</h1>
            <p>Hi,${details.userEmail} </p>
            <p>Thank you for your payment. Your purchase is confirmed and we're excited to have you.</p>
            <div class="details">
                <p><strong>Product:</strong> ${details.productName}</p>
                <p><strong>Amount Paid:</strong> ₹${details.amount}</p>
                <p><strong>Payment ID:</strong> ${details.paymentId}</p>
            </div>
            <p>If you have any questions, feel free to contact us at hi@manav.in.</p>
            <br/>
            <p>Thanks,</p>
            <p>Team Manav</p>
        </div>
    </body>
    </html>`;

    const mailOptions = {
        from: `"Manav" <${process.env.EMAIL_USER}>`,
        to: userEmail,
        subject: 'Payment Confirmation - Your Spot is Confirmed!',
        html: emailHtml,
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`Payment confirmation email sent to ${userEmail}`);
    } catch (error) {
        console.error('Error sending confirmation email:', error);
        throw new Error('Failed to send confirmation email.');
    }
}

// --- Server Start ---
app.listen(port, () => {
    console.log(`✅ Notion API server running at http://localhost:${port}`);
    console.log(`   Endpoints:`);
    console.log(`     GET /trails (List all trails - basic info)`);
    console.log(`     GET /trails/{id_or_slug} (Get full trail details)`);
    if (process.env.NODE_ENV !== 'production') {
        console.log('\n--- Debug Info ---');
        console.log('Database ID:', databaseId);
        console.log('Token Preview:', process.env.NOTION_TOKEN ? `${process.env.NOTION_TOKEN.slice(0, 6)}...` : 'Not Set');
        console.log('------------------\n');
    }
});

process.on('SIGINT', () => {
    console.log('\n🚦 Received SIGINT, shutting down gracefully...');
    process.exit(0);
});