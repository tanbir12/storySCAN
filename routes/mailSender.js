import nodemailer from 'nodemailer';
import dotenv from "dotenv";
dotenv.config();

export const sendMail  = async (to,subject,text) => {
    let transporter = nodemailer.createTransport({
        service: 'Gmail',
        host: 'smtp.gmail.com',
        port: 465,
        auth: {
            user: 'scimuphilelab@gmail.com',
            pass: process.env.MAIL_PASSWORD,
        }
    });

    // Set up email data
    let mailOptions = {
        from: 'scimuphilelab@gmail.com',
        to: to,
        subject: subject,
        text: text
    };

    // Send email
    try {
        let info = await transporter.sendMail(mailOptions);
        console.log('Email sent: ' + info.response);
    } catch (error) {
        console.error('Error sending email: ', error);
    }
}