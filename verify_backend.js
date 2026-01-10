const axios = require('axios');
const FormData = require('form-data');

const API_URL = 'http://localhost:8000/api';

async function verifyBackend() {
    console.log('Starting Backend Verification...');

    // 1. Health Check
    try {
        const health = await axios.get('http://127.0.0.1:8000/');
        console.log('✅ Health Check Passed:', health.data);
    } catch (error) {
        console.error('❌ Health Check Failed:', error.message);
        if (error.code) console.error('Code:', error.code);
        process.exit(1);
    }

    // 2. Register User
    const userData = {
        name: 'Test User',
        email: `test_${Date.now()}@example.com`,
        phone: `080${Date.now().toString().slice(-8)}`,
        password: 'password123',
        confirmPassword: 'password123'
    };

    let token = '';

    try {
        const form = new FormData();
        for (const key in userData) {
            form.append(key, userData[key]);
        }

        console.log('Attempting Registration with:', userData.email);
        const regRes = await axios.post(`${API_URL.replace('localhost', '127.0.0.1')}/auth/register`, form, {
            headers: { ...form.getHeaders() }
        });
        console.log('✅ Registration Successful:', regRes.data.message);
    } catch (error) {
        console.error('❌ Registration Failed:', error.response ? error.response.data : error.message);
        // If fail, try login (user might exist if script re-run quickly with valid email, though using timestamp helps)
    }

    // 3. Login
    try {
        console.log('Attempting Login...');
        const loginRes = await axios.post(`${API_URL}/auth/login`, {
            email: userData.email,
            password: userData.password
        });
        console.log('✅ Login Successful');
        token = loginRes.data.token || loginRes.data.accessToken;
        if (!token) console.warn('⚠️ No token returned in login response');
    } catch (error) {
        console.error('❌ Login Failed:', error.response ? error.response.data : error.message);
        process.exit(1);
    }

    // 4. Protected Route
    if (token) {
        try {
            const meRes = await axios.get(`${API_URL}/auth/me`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            console.log('✅ Protected Route (/me) Accessed:', meRes.data.user.email);
        } catch (error) {
            console.error('❌ Protected Route Failed:', error.response ? error.response.data : error.message);
        }
    }

    console.log('Backend Verification Complete.');
}

// Simple wait for server to start
setTimeout(verifyBackend, 5000);
