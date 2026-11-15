import { Schema,model } from "mongoose";

const itemScheam = new Schema({
    title: {type:String , required: true},
    description: String ,
    owner : {type:Schema.Types.ObjectId,ref:'User',required:true},
},{timestamps:true});

const Item = model('Item',itemScheam);

export default Item;