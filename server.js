// server.js

import express from 'express';
import multer from 'multer';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises'; // Use the promise-based fs module
import { GoogleAIFileManager } from '@google/generative-ai/server';
import { GoogleGenerativeAI } from '@google/generative-ai';
import admin from 'firebase-admin';
import { createRequire } from 'module'; // Add this line

// Create a require function
const require = createRequire(import.meta.url);
dotenv.config();
// Import the service account JSON using require
const serviceAccount = require(process.env.FIREBASEKEYPATH);

// Emulate __dirname in ES6 modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from .env file

console.log('API Key:', process.env.API_KEY);

// Initialize Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// Initialize Express app
const app = express();

// Enable CORS
app.use(
  cors({
    origin: 'https://patchup-pdf-upload.vercel.app', // Your frontend's URL
    credentials: true,
  })
);

// Configure multer for file upload with file type and size validation
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/'); // Ensure this directory exists
  },
  filename: function (req, file, cb) {
    // Append the date timestamp to the filename to ensure uniqueness
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(
      null,
      `${file.fieldname}-${uniqueSuffix}${path.extname(file.originalname)}`
    );
  },
});

// File filter to allow only PDF files
const fileFilter = (req, file, cb) => {
  const filetypes = /pdf/;
  const mimetype = filetypes.test(file.mimetype);
  const extname = filetypes.test(
    path.extname(file.originalname).toLowerCase()
  );

  if (mimetype && extname) {
    return cb(null, true);
  }
  cb(new Error('Only PDF files are allowed'));
};

// Initialize multer with storage, file filter, and size limits
const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: fileFilter,
});

// Initialize Google Gemini API components
const apiKey = process.env.API_KEY;
if (!apiKey) {
  console.error('ERROR: API_KEY is not set in the environment variables.');
  process.exit(1);
}

const fileManager = new GoogleAIFileManager(apiKey);
const genAI = new GoogleGenerativeAI(apiKey);
// No need to reinitialize the model instance here since it's done in the route

// Route: POST /upload
app.post('/upload', upload.single('pdf'), async (req, res) => {
  if (!req.file) {
    return res
      .status(400)
      .json({ message: 'File upload failed. No file provided.' });
  }

  const uploadPath = req.file.path;
  console.log('Uploaded:', uploadPath);

  try {
    // Resolve the absolute path of the uploaded file
    const mediaPath = path.resolve(uploadPath);

    // Upload the file to Google Gemini
    const uploadResult = await fileManager.uploadFile(mediaPath, {
      mimeType: 'application/pdf',
      displayName: req.file.originalname || 'Uploaded PDF',
    });

    console.log(
      `Uploaded file ${uploadResult.file.displayName} as: ${uploadResult.file.uri}`
    );
    // Initialize Google Generative AI model
    const modelInstance = genAI.getGenerativeModel({
      model: 'gemini-1.5-flash',
    });

    // Define the prompt for content generation
    const prompt = `
You are tasked with extracting specific data from the provided PDF and outputting it strictly in valid JSON format. The JSON object should contain the following fields:

1. \`main_artist\`: The name of the main artist or performer.
2. \`patch_list_table\`: A table extracted from the "PATCH LIST" section, with the following columns:
   - \`Channel Number\`: The channel number.
   - \`Mic/DI\`: The microphone or DI box used.
   - \`Patch Name\`: The name of the patch.
   - \`Comments/Stands\`: Any comments or stand-related information.

### Important:
- Always ensure the JSON follows proper syntax, including correct use of commas, brackets, and quotation marks.
- If you cannot extract a particular field, include it with a null value (e.g., "main_artist": null).
- Validate the JSON output to avoid errors.
- Do not include any text outside of the JSON object. The output must only contain valid JSON.

Ensure flexibility in recognizing alternative headings or variations in terminology for instruments and backlines. Parse the data accurately and output the structured JSON.
    `;

    // Request content generation based on the uploaded file and prompt
    const result = await modelInstance.generateContent([
      prompt,
      {
        fileData: {
          fileUri: uploadResult.file.uri,
          mimeType: uploadResult.file.mimeType,
        },
      },
    ]);

    // Extract the text from the response
    let extractedText = await result.response.text();
    console.log('Raw Extracted Text:', extractedText);

    // Process the extracted text to remove markdown formatting if present
    // Remove ```json and ``` markers
    const codeBlockRegex = /^```json\s*([\s\S]*?)\s*```$/;
    const match = extractedText.match(codeBlockRegex);

    if (match && match[1]) {
      extractedText = match[1];
    }

    // Attempt to parse the JSON string
    let extractedData;
    try {
      extractedData = JSON.parse(extractedText);
      console.log('Parsed Extracted Data:', JSON.stringify(extractedData, null, 2));
    } catch (parseError) {
      console.error('Error parsing extracted text as JSON:', parseError);
      return res
        .status(500)
        .json({ message: 'Invalid JSON format in extracted data.' });
    }

    // Proceed with Firestore write
    try {
      // Validate the presence of required fields
      const { main_artist, patch_list_table } = extractedData;

      console.log('Main Artist:', main_artist);
      console.log('Patch List Table:', patch_list_table);

      if (!main_artist || !patch_list_table) {
        console.error('Missing main_artist or patch_list_table in extracted data.');
        return res.status(400).json({
          message:
            'Extracted data is missing required fields: main_artist or patch_list_table.',
        });
      }

      console.log('Number of Patches:', patch_list_table.length);

      // Sanitize the main_artist to create a valid Firestore collection name
      const sanitizedMainArtist = main_artist
        .replace(/\s+/g, '_')
        .replace(/[^a-zA-Z0-9_]/g, '');

      console.log('Sanitized Main Artist:', sanitizedMainArtist);

      // Reference to the new collection named after the main_artist
      const artistCollectionRef = db.collection(sanitizedMainArtist);

      // Batch write to Firestore for efficiency
      const batch = db.batch();
      let writeCount = 0;

      patch_list_table.forEach((patch) => {
        const {
          channelNumber, // Assuming camelCase
          micOrDi,
          patchName,
          commentsOrStand,
        } = patch;

        if (
          channelNumber === undefined ||
          micOrDi === undefined ||
          patchName === undefined ||
          commentsOrStand === undefined
        ) {
          console.warn(
            'Patch entry is missing one or more required fields. Skipping:',
            patch
          );
          return; // Skip this entry
        }

        // Create a document reference with channelNumber as the document ID
        const docRef = artistCollectionRef.doc(String(channelNumber));

        // Set the document data
        batch.set(docRef, {
          channelNumber: channelNumber,
          micOrDi: micOrDi,
          patchName: patchName,
          commentsOrStand: commentsOrStand,
        });

        writeCount++;
      });

      if (writeCount === 0) {
        console.warn('No valid patch entries to write to Firestore.');
        return res.status(400).json({
          message: 'No valid patch entries found in patch_list_table.',
        });
      }

      // Commit the batch
      await batch.commit();
      console.log(
        `Successfully saved ${writeCount} patches to Firestore collection: ${sanitizedMainArtist}`
      );

      // Optionally, delete the uploaded file from your server to save space
      try {
        await fs.unlink(mediaPath);
        console.log('Uploaded file deleted successfully.');
      } catch (err) {
        console.error('Error deleting uploaded file:', err);
        // Continue without sending an error, since the main operation was successful
      }

      // Send the extracted data back to the frontend as JSON
      res.status(200).json({
        message: 'File uploaded and processed successfully.',
        uploadConfirmation: 'File Upload successful.',
        geminiResponse: extractedData,
      });
    } catch (firestoreError) {
      console.error('Error writing to Firestore:', firestoreError);
      res.status(500).json({
        message: 'Error saving data to Firestore.',
        error: firestoreError.message || 'Internal Server Error',
      });
    }
  } catch (error) {
    console.error('Error processing the PDF:', error);

    // Attempt to delete the uploaded file in case of an error
    const mediaPath = path.resolve(uploadPath);
    try {
      await fs.unlink(mediaPath);
      console.log('Uploaded file deleted after failure.');
    } catch (err) {
      console.error('Error deleting uploaded file after failure:', err);
      // No need to send an error response for this deletion failure
    }

    res.status(500).json({
      message: 'Error processing the PDF',
      error: error.message || 'Internal Server Error',
    });
  }
});

// Global Error Handler for Multer Errors
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    // Handle Multer-specific errors
    return res.status(400).json({ message: err.message });
  } else if (err) {
    // Handle other errors
    return res.status(400).json({ message: err.message });
  }
  next();
});

// Start the server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

// Optional: Test Firestore connection
(async () => {
  try {
    const testDoc = db.collection('testCollection').doc('testDoc');
    await testDoc.set({ testField: 'testValue' });
    console.log('Firestore connection successful. Test document created.');
    // Optionally, delete the test document
    await testDoc.delete();
    console.log('Test document deleted.');
  } catch (testError) {
    console.error('Error connecting to Firestore:', testError);
  }
})();
