const nodemailer = require('nodemailer')

const sendEmail = async (to, subject, html) => {
    const transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true, // true for 465, false for other ports
        auth: {
            user: process.env.MAIL_USER,
            pass: process.env.MAIL_PASS
        },
        connectionTimeout: 10000, // 10 seconds
        greetingTimeout: 5000,    // 5 seconds
        socketTimeout: 10000,     // 10 seconds
    })

    try {
        const info = await transporter.sendMail({
            from: `"Zantara VTU" <${process.env.MAIL_USER}>`,
            to,
            subject,
            html
        })
        console.log("Email sent successfully:", info.messageId);
        return info;
    } catch (error) {
        console.error("Email send failed:", error);
        throw error;
    }
}

module.exports = { sendEmail }