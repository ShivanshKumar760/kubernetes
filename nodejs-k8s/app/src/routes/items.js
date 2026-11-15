import { Router } from "express";
import auth from "../middleware/auth.js";
import Item from "../models/Item.js"


const router = Router();
router.use(auth);

router.post('/',async (req , res)=>{
    const item = await Item.create({...req.body,owner:req.user.id});
    res.status(201).json(item);
});

router.get('/',async (req , res)=>{
   return res.json(await Item.find({owner:req.user.id}));
});

router.get('/:id',async (req,res)=>{
    const item = await Item.findOne({_id:req.params.id,owner:req.user.id});
    item ? res.json(item) : res.status(404).json({error:'Not found'});
});

router.put('/:id',async (req,res)=>{
    const item = await Item.findOneAndUpdate(
        {_id:req.params.id,owner:req.user.ud},req.body,{new:true}
    );
    item ? res.json(item) : res.status(404).json({error:'Not found'});
});

router.delete('/:id',async (req,res)=>{
    const item = await Item.findOneAndDelete({_id:req.params.id,owner:req.user.id});
    item ? res.status(204).end() : res.status(404).json({error:'Not found'});
});


export default router ;