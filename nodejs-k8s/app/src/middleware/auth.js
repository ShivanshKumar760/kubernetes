import jwt from "jsonwebtoken";

function auth(req,res,next){
    const token = (req.headers.authorization || '').replace('Bearer ','');
    try {
        req.user = jwt.verify(token,process.env.JWT_SECRET);
        next();
    } catch (error) {
        res.status(401).json({error:'Invalid or missing token'});
    }
};

export default auth;