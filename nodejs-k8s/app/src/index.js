import dotenv from 'dotenv';
import express from 'express';
import mongoose from 'mongoose';
import authRouter from './routes/auth.js';
import itemRouter from './routes/items.js';
dotenv.config();
const app = express();
app.use(express.json());

app.get('/health',(_,res)=>{
    return res.json({status:'ok'});
});

app.use('/auth',authRouter);
app.use('/items',itemRouter);

const PORT = process.env.PORT || 3000;
mongoose.connect(process.env.MONGO_URI).then(()=>{
    app.listen(PORT,()=>console.log(`Listening on ${PORT}`));
}).catch((e)=>{
    console.error('Mongo Connection failed',e);
    process.exit(1);
});