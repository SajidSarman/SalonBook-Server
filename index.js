import express from 'express';
import 'dotenv/config'
import cors from 'cors';
import { MongoClient } from 'mongodb';

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(express.json());
app.use(cors());

const client = new MongoClient(process.env.MONGODB_URI);


export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
  }
}

const connectedClient = await connectToMongoDB();
const database = connectedClient.db("SalonBook_DB");
const users = database.collection("user");


app.get('/', (req, res) => {
  res.send('TESTING...');
});

app.listen(port, () => {
  console.log(`SalonBook is running on port ${port}`);
});