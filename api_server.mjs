
import express from 'express';
import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';

// Load environment variables from .env file
dotenv.config();

const app = express();
app.use(express.json());

const client = new MongoClient(process.env.MONGODB_URI);

async function connectToMongoDB() {
  if (!client.isConnected()) {
    await client.connect();
    console.log('Connected to MongoDB');
  }
  return client.db(process.env.DB_NAME);
}

app.use(async (req, res, next) => {
  req.db = await connectToMongoDB();
  next();
});

// Tweets endpoints

// Get all tweets
app.get('/tweets', async (req, res) => {
  const tweetsCollection = req.db.collection('tweets');
  const tweets = await tweetsCollection.find({}).toArray();
  res.json(tweets);
});

// Get a tweet by ID
app.get('/tweets/:id', async (req, res) => {
  const tweetsCollection = req.db.collection('tweets');
  const tweet = await tweetsCollection.findOne({ id: req.params.id });
  res.json(tweet);
});

// Add a new tweet
app.post('/tweets', async (req, res) => {
  const tweetsCollection = req.db.collection('tweets');
  await tweetsCollection.insertOne(req.body);
  res.status(201).json(req.body);
});

// Update a tweet
app.put('/tweets/:id', async (req, res) => {
  const tweetsCollection = req.db.collection('tweets');
  await tweetsCollection.updateOne({ id: req.params.id }, { $set: req.body });
  res.json(req.body);
});

// Authors endpoints

// Get all authors
app.get('/authors', async (req, res) => {
  const authorsCollection = req.db.collection('authors');
  const authors = await authorsCollection.find({}).toArray();
  res.json(authors);
});

// Get an author by ID
app.get('/authors/:id', async (req, res) => {
  const authorsCollection = req.db.collection('authors');
  const author = await authorsCollection.findOne({ id: req.params.id });
  res.json(author);
});

// Add a new author
app.post('/authors', async (req, res) => {
  const authorsCollection = req.db.collection('authors');
  await authorsCollection.insertOne(req.body);
  res.status(201).json(req.body);
});

// Responses endpoints

// Get all responses
app.get('/responses', async (req, res) => {
  const responsesCollection = req.db.collection('responses');
  const responses = await responsesCollection.find({}).toArray();
  res.json(responses);
});

// Get a response by tweet ID
app.get('/responses/tweet/:tweet_id', async (req, res) => {
  const responsesCollection = req.db.collection('responses');
  const response = await responsesCollection.findOne({ tweet_id: req.params.tweet_id });
  res.json(response);
});

// Add a new response
app.post('/responses', async (req, res) => {
  const responsesCollection = req.db.collection('responses');
  await responsesCollection.insertOne(req.body);
  res.status(201).json(req.body);
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API Server is running on port ${PORT}`);
});