const express = require("express");
const body_parser = require("body-parser");
const axios=require("axios");
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

const app = express().use(body_parser.json());

const mytoken = "32D721YWSetkhiID5j5yqxICLo8MmDgm";


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
    // Log the entire request method and URL
    //console.log(`Received ${req.method} request to ${req.originalUrl}`);
    // Log the entire body request
    //console.log(JSON.stringify(req.body, null, 2)); // Pretty print the body

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
            console.log("Sending Id",contextId);
            console.log("Message From Number",messageData.from);
            const ref = await db.collection('WhatsAppLog').doc(contextId).get();
            if (ref.exists) {
                // Extract the alertTableId from the document
                const alertTableId = ref.data().alertTableId;
                const alertTableRef = await db.collection('AlertTable').doc(alertTableId).get();
                const alertData = alertTableRef.data();
                const userId=alertData.UserId;
                const userTableRef = await db.collection('UserTable').doc(userId).get();
                const userData = userTableRef.data();
                const userName=userData.FullName;
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

            // const logData = {
            //     phone_number_id: body_param.entry[0].changes[0].value.metadata.phone_number_id,
            //     wa_id: messageData.from,
            //     message_id: contextId,
            //     timestamp: messageData.timestamp
            // };
            //await logToFirestore(logData);
        }
        res.sendStatus(200);
    } else {
        res.sendStatus(405).send("Method Not Allowed");
    }
});

app.get("/", (req, res) => {
    res.status(200).send("Hello, this is webhook setup");
});