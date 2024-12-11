
import axios from 'axios';
import express from 'express';
import dotenv from 'dotenv';
import mysql from 'mysql2';
import cors from 'cors';
import AWS from 'aws-sdk';
import multer from 'multer';
import winston from 'winston';
import nodemailer from 'nodemailer';
import bodyParser from 'body-parser';
dotenv.config();

const openaiApiKey = process.env.OPENAI_API_KEY;

const logger = winston.createLogger({
  level: "info",
  format: winston.format.json(),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: "error.log", level: "error" }),
    new winston.transports.File({ filename: "combined.log" }),
  ],
});

logger.info("This is an informational message");

// Configure AWS S3
AWS.config.update({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION,
});
  
const s3 = new AWS.S3();
const bucketName = process.env.S3_BUCKET_NAME;
const app = express();
const PORT = process.env.PORT || 5001;


app.use(
  cors({
    origin: process.env.NETLIFY_URL || "http://localhost:3000",
    credentials: true,
  })
);
app.use(express.json());

// MySql Environment 
const db = mysql.createConnection({
    host: process.env.MYSQL_HOST,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
});  

// Connect MySQL
db.connect((err) => {
  if (err) {
    console.error("Error connecting to MySQL:", err);
    return;
  }
  console.log("Connected to MySQL database.");
});

app.post("/api/signup", (req, res) => {
  const { username, password, firstName, lastName, email } = req.body;

  // check user is already exist
  const checkUserQuery = "SELECT * FROM users WHERE username = ?";
  db.query(checkUserQuery, [username], (err, results) => {
    if (err) {
      console.error("Error querying database:", err);
      return res.status(500).json({ error: "Internal server error" });
    }

    if (results.length > 0) {
      // if existed
      return res.status(400).json({ message: "Username already exists" });
    }

    // inset new users
    const insertUserQuery = "INSERT INTO users (username, password, firstName, lastName, email) VALUES (?, ?, ?, ?, ?)";
    db.query(insertUserQuery, [username, password, firstName, lastName, email], (err, results) => {
      if (err) {
        console.error("Error inserting data into MySQL:", err);
        return res.status(500).json({ error: "Internal server error" });
      }
      res.status(201).json({ message: "User registered successfully" });
    });
  });
});

//login check with databse
app.post("/api/login", (req, res) => {
  const { username, password } = req.body;

  // check username is alreay exist no not
  const query = "SELECT * FROM users WHERE username = ?";
  db.query(query, [username], (err, results) => {
    if (err) {
      console.error("Error querying database:", err);
      return res.status(500).json({ error: "Internal server error" });
    }

    if (results.length === 0) {
      // the user is not existed
      return res.status(404).json({ message: "User not found. Please sign up." });
    } 

    // check password
    const user = results[0];
    if (user.password !== password) {
      return res.status(401).json({ message: "Incorrect username or password." });
    }
    res.status(200).json({ message: "Login successful" });
  });
});

app.post("/api/check", (req, res) => {
  const { username, email } = req.body;

  const query = `SELECT * FROM users WHERE username = ? OR email = ?`;
  db.query(query, [username, email], (err, results) => {
    if (err) {
      console.error("Error querying database:", err);
      return res.status(500).json({ error: "Internal server error" });
    }

    if (results.length > 0) {
      if (results[0].username === username) {
        return res.status(400).json({ message: "Username already exists" });
      }
      if (results[0].email === email) {
        return res.status(400).json({ message: "Email already exists" });
      }
    }
    res.status(200).json({ message: "Available" });
  });
});



// Configure multer for handling file uploads
const upload = multer();

// Define the upload route
app.post('/api/upload', upload.single('profileImage'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }
  try {
    const params = {
      Bucket: bucketName,
      Key: `profile-images/${Date.now()}`,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
      ACL: 'public-read', // Optional: Makes the file publicly readable
    };

    const data = await s3.upload(params).promise();
    //update mysql


    res.send({ fileUrl: data.Location });
  } catch (error) {
    console.error("Error uploading file:", error);
    res.status(500).send("Failed to upload file");
  }
});

//upload imgurl to mysql
app.post('/api/img',(req, res)=>{
  const {img,username}=req.body;
  if (!img || !username) {
    return res.status(400).json({ error: "img and username are required" });
  }
  logger.info(req.body);

  const urlquery = `UPDATE users SET img = ? WHERE username = ?`;
  db.query(urlquery,[img,username],(err, results) => {
    if (err) {
      console.error("Error querying database:", err);
      return res.status(500).json({error: "Internal server error"});
    }

  });
    res.status(200).json({ message: "img update successful"+ img });
})

//get
app.get('/api/profile', (req, res) => {
  const username = req.query.username; // Expect username as a query parameter

  if (!username) {
    return res.status(400).json({ error: "Username is required" });
  }

  const query = `SELECT username, email, img FROM users WHERE username = ?`;
  db.query(query, [username], (err, results) => {
    if (err) {
      console.error("Error querying database:", err);
      return res.status(500).json({ error: "Internal server error" });
    }

    if (results.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    res.status(200).json(results[0]); // Return the user profile data
  });
});

//use ai to recommend music
app.post('/api/recommend',  async (req, res) => {
  const {activity, mood, time, weather} = req.body;
  logger.info(mood);
  try {
    const completion = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-4',
          messages: [
            {
              role: "system",
              content: "you are a music expert, user will tell you their mood, activity they are doing, time, and weather. Provide five songs in the following structured JSON format:\n" +
                  "      [\n" +
                  "        {\n" +
                  "          \"title\": \"Song Title\",\n" +
                  "          \"artist\": \"Artist Name\",\n" +
                  "          \"link\": \"Song Link (e.g., Spotify, YouTube)\"\n" +
                  "        },\n" +
                  "        ...\n" +
                  "      ]"
            },
              {role: "user", content: `I'm ${activity} now and my mood is ${mood}, it's ${time} now and the weather is ${weather}, please recommend some songs to me`}
          ]
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${openaiApiKey}`,
          },
        }
    );
    const recommendations = JSON.parse(completion.data.choices[0].message.content);
    logger.info(recommendations);
    res.json({recommendations});
  } catch (error) {
    logger.error("fail to get response from openai");
    res.status(500).send("Failed to get recommendations");
  }
});

//Like
app.post('/api/like', (req, res) => {
  const { username, title, artist, link } = req.body;

  if (!username || !title || !artist || !link) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  const sql = `INSERT INTO user_liked_music (username, title, artist, link) VALUES (?, ?, ?, ?)`;
  const values = [username, title, artist, link];

  db.query(sql, values, (err, results) => {
    if (err) {
      console.error('Error inserting record:', err);
      return res.status(500).json({ error: 'Database error' });
    }
    res.status(201).json({ message: 'Like recorded', id: results.insertId });
  });
});

//Get all liked songs
app.get('/api/liked-songs/:username', (req, res) => {
  const { username } = req.params;

  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }

  const sql = `    SELECT title, artist, link 
    FROM user_liked_music 
    WHERE LOWER(TRIM(username)) = LOWER(TRIM(?))
  `;
  const values = [username];

  db.query(sql, values, (err, results) => {
    if (err) {
      console.error('Error fetching liked songs:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    if (results.length === 0) {
      return res.status(404).json({ message: 'No liked songs found for this user' });
    }

    res.status(200).json(results);
  });
});

//unlike
app.post('/api/unlike', (req, res) => {
  const { username, title, artist } = req.body;

  if (!username || !title || !artist) {
    return res.status(400).json({ error: 'Username, title, and artist are required' });
  }

  const sql = `DELETE FROM user_liked_music WHERE username = ? AND title = ? AND artist = ?`;
  const values = [username, title, artist];

  db.query(sql, values, (err, results) => {
    if (err) {
      console.error('Error deleting record:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    if (results.affectedRows === 0) {
      return res.status(404).json({ message: 'No matching record found to delete' });
    }

    res.status(200).json({ message: 'Song unliked successfully' });
  });
});

function truncateResponseTo100Words(text) {
  const words = text.split(" ");
  return words.length > 100 ? words.slice(0, 100).join(" ") + "..." : text;
}

//Chatbot
app.post("/api/chat", async (req, res) => {
  const { userInput } = req.body;

  if (!userInput) {
    return res.status(400).json({ error: "User input is required." });
  }

  const promptTemplate = `
  You are a music expert assistant. Respond directly to the following question in 100 words or fewer:
  Question: "${userInput}"
  Use bullet points or a numbered list and avoid unnecessary details.
`;

  try {
    const completion = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4",
        messages: [
          {
            role: "system",
            content: `
              You are a music expert assistant. 
              Your task is to answer questions in a concise, factual, and structured manner. 
              Avoid providing unnecessary background information or disclaimers. 
              Always respond directly to the user's query in a structured format, such as bullet points or a numbered list. 
              Limit your response to 100 words or fewer. Do not exceed this word count.
            `
          },
          { role: "user", content: promptTemplate},
        ],
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${openaiApiKey}`,
        },
      }
    );

    let botResponse = completion.data.choices[0].message.content;
    botResponse = truncateResponseTo100Words(botResponse);
    res.json({ response: botResponse });
  } catch (error) {
    console.error("OpenAI API Error:", error.message);
    res.status(500).json({ error: "Failed to process your request." });
  }
});

// email verification

const sendVerificationEmail = async (email, code) => {
  const transporter = nodemailer.createTransport({
    service: 'Gmail',
    auth: {
      user: process.env.gmail_user,
      pass: process.env.gmail_pass,
    },
  });

  const mailOptions = {
    from: process.env.gmail_user,
    to: email,
    subject: 'Email Verification',
    text: `Your verification code is: ${code}`,
  };

  return transporter.sendMail(mailOptions);
};
// Generate random 6-digit code
const generateCode = () => Math.floor(100000 + Math.random() * 900000);

let verificationCodes = {}; // To store email and code temporarily

app.use(bodyParser.json());

app.post('/api/send-code', async (req, res) => {
  const { email } = req.body;
  const code = generateCode();
  verificationCodes[email] = code;

  try {
    await sendVerificationEmail(email, code);
    res.status(200).send({ message: 'Verification code sent.' });
  } catch (error) {
    res.status(500).send({ message: 'Failed to send email.' });
  }
});

app.post('/api/verify-code', (req, res) => {
  const { email, code } = req.body;

  if (verificationCodes[email] === parseInt(code)) {
    delete verificationCodes[email];
    res.status(200).send({ message: 'Email verified.' });
  } else {
    res.status(400).send({ message: 'Invalid code.' });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
