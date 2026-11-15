import { json, Router } from "express";
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import User from "../models/User.js";

const router = Router();

router.post('/register',async (req , res )=> {
    try {
        const {email,password} = req.body;
        const user = await User.create({email,password:await bcrypt.hash(password,10)});
        res.status(201).json({id:user._id,email:user.email});
    } catch (error) {
        res.status(400),json({error:e.message});
    }
});

router.post('/login',async (req,res)=>{
    const {email,password} = req.body;
    const user =  await User.findOne({email});
    if (!user || !(await bcrypt.compare(password,user.password))){
        return res.status(401).json({error:'Bad credentials'});
    }
    const token = jwt.sign({id:user._id},process.env.JWT_SECRET,{expiresIn:'1h'});
    res.json({token});
});


export default router;