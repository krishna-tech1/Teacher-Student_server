const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 5056;

// DB Pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// Cloudinary Configuration
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// Set up Cloudinary storage for Multer
const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'school_documents',
        resource_type: 'auto', // Support PDF, Doc, Images etc.
        allowed_formats: ['jpg', 'png', 'pdf', 'docx', 'xlsx', 'txt']
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB Upload Limit
});

app.use(cors());
app.use(express.json());

// Logger
app.use((req, res, next) => {
    console.log(`[PORTAL DEBUG] ${req.method} ${req.url}`);
    next();
});

// Database Initialization
const initDB = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS homework (
                id SERIAL PRIMARY KEY,
                teacher_id VARCHAR(50) NOT NULL,
                class_name VARCHAR(50) NOT NULL,
                section VARCHAR(10) NOT NULL,
                subject VARCHAR(100) NOT NULL,
                title VARCHAR(200) NOT NULL,
                description TEXT,
                attachments TEXT,
                due_date DATE,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            );
            
            CREATE TABLE IF NOT EXISTS notifications (
                id SERIAL PRIMARY KEY,
                user_id VARCHAR(50) NOT NULL,
                title VARCHAR(100) NOT NULL,
                message TEXT NOT NULL,
                is_read BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS announcements (
                id SERIAL PRIMARY KEY,
                sender_id VARCHAR(50) NOT NULL,
                sender_name VARCHAR(100) NOT NULL,
                sender_role VARCHAR(20) NOT NULL,
                target_type VARCHAR(20) NOT NULL,
                target_class VARCHAR(50),
                title VARCHAR(100) NOT NULL,
                message TEXT NOT NULL,
                type VARCHAR(20) DEFAULT 'info',
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS student_attendance (
                id SERIAL PRIMARY KEY,
                "studentId" VARCHAR(50) NOT NULL,
                class VARCHAR(50) NOT NULL,
                section VARCHAR(10) NOT NULL,
                date DATE NOT NULL,
                status VARCHAR(20) NOT NULL,
                remarks TEXT,
                "submitted_by" VARCHAR(50),
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                UNIQUE ("studentId", date)
            );

            CREATE TABLE IF NOT EXISTS student_marks (
                id SERIAL PRIMARY KEY,
                "studentId" VARCHAR(50) NOT NULL,
                class VARCHAR(50) NOT NULL,
                section VARCHAR(10) NOT NULL,
                subject VARCHAR(100) NOT NULL,
                exam_type VARCHAR(20) NOT NULL,
                marks VARCHAR(10),
                remarks TEXT,
                submitted_by VARCHAR(50),
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                UNIQUE ("studentId", subject, exam_type)
            );

            CREATE TABLE IF NOT EXISTS homework_submissions (
                id SERIAL PRIMARY KEY,
                homework_id INT NOT NULL,
                "studentId" VARCHAR(50) NOT NULL,
                student_name VARCHAR(100),
                submission_url TEXT,
                grade VARCHAR(20),
                feedback TEXT,
                submitted_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (homework_id, "studentId")
            );
            
            -- Set up indices for performance (Fix #3)
            CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
            CREATE INDEX IF NOT EXISTS idx_subs_homework_id ON homework_submissions(homework_id);
            CREATE INDEX IF NOT EXISTS idx_subs_student_id ON homework_submissions("studentId");
        `);
        console.log('✅ Database tables and indices verified');

        // Automatic Maintenance: Delete old notifications (Fix #3)
        await pool.query("DELETE FROM notifications WHERE created_at < NOW() - INTERVAL '30 days'");
        console.log('🧹 Cleaned up notifications older than 30 days');

    } catch (err) {
        console.error('❌ DB Init Error:', err);
    }
};
initDB();

// Global Timezone Enforcement (Fix #6 - IST)
pool.on('connect', (client) => {
    client.query('SET timezone = "Asia/Kolkata"');
});

// Portal Router
const portalRouter = express.Router();

// [MOVED OR REMOVED FOR SECURITY] Debug DB Path removed for production.

// Login Logic
portalRouter.post('/login', async (req, res) => {
    try {
        const { id, dob, role } = req.body;
        console.log(`[LOGIN ATTEMPT] Role: ${role}, ID: ${id}`);

        let userResult;

        if (role === 'student') {
            userResult = await pool.query(
                `SELECT * FROM students 
                 WHERE "studentId" = $1 AND "dateOfBirth"::text = $2`,
                [id, dob]
            );
        } else if (role === 'teacher') {
            userResult = await pool.query(
                `SELECT * FROM staff 
                 WHERE LOWER("staffId") = LOWER($1) AND dob::text = $2`,
                [id, dob]
            );
        } else {
            return res.status(400).json({ message: 'Invalid role specified' });
        }

        const user = userResult.rows[0];
        console.log(`[LOGIN DEBUG] Found user? ${user ? 'YES (' + user.id + ')' : 'NO (Check ID: ' + id + ', DOB: ' + dob + ')'}`);

        if (!user) {
            return res.status(401).json({ message: 'Invalid ID or Date of Birth' });
        }

        // Generate Token
        const jwtSecret = process.env.JWT_SECRET;
        if (!jwtSecret) {
            console.error('CRITICAL: JWT_SECRET environment variable is missing!');
            return res.status(500).json({ message: 'Security misconfiguration: Missing Secret.' });
        }

        const token = jwt.sign(
            { id: user.id, role: role, name: `${user.firstName} ${user.lastName}` },
            jwtSecret,
            { expiresIn: '7d' }
        );

        res.json({
            token,
            user: {
                ...user,
                id: user.studentId || user.staffId || user.id,
                name: `${user.firstName} ${user.lastName}`,
                role: role
            }
        });
    } catch (err) {
        console.error('Portal Login Error:', err);
        res.status(500).json({ message: 'Server error during portal login' });
    }
});

// Profile Logic
portalRouter.get('/profile', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ message: 'No token provided' });
        }

        const jwtSecret = process.env.JWT_SECRET;
        if (!jwtSecret) throw new Error('JWT_SECRET missing');

        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, jwtSecret);

        let result;
        if (decoded.role === 'student') {
            result = await pool.query('SELECT "studentId", "firstName", "lastName", class, section, email FROM students WHERE "studentId" = $1', [decoded.id]);
        } else {
            result = await pool.query('SELECT "staffId", "firstName", "lastName", department, email FROM staff WHERE "staffId" = $1', [decoded.id]);
        }

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'User profile not found' });
        }

        res.json({ user: result.rows[0] });
    } catch (err) {
        res.status(401).json({ message: 'Invalid or expired token' });
    }
});

// Leave Application Logic
portalRouter.post('/leaves', async (req, res) => {
    try {
        const { staffId, leaveType, startDate, endDate, reason } = req.body;

        // Validation
        if (!staffId || !leaveType || !startDate || !endDate || !reason) {
            return res.status(400).json({ message: 'All fields are mandatory.' });
        }

        // Check if startDate is in the past
        const start = new Date(startDate);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        if (start < today) {
            return res.status(400).json({ message: 'You cannot apply for leave on past dates.' });
        }

        // Limit reason to 75 characters
        if (reason.length > 75) {
            return res.status(400).json({ message: 'Description cannot exceed 75 characters.' });
        }

        const query = `
            INSERT INTO staff_leaves ("staffId", "leaveType", "startDate", "endDate", "reason", "status")
            VALUES ($1, $2, $3, $4, $5, 'Pending')
            RETURNING *
        `;
        const result = await pool.query(query, [staffId, leaveType, startDate, endDate, reason]);
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('Leave Application Error:', err);
        res.status(500).json({ message: 'Error submitting leave application.' });
    }
});

// Get Leave History for a Staff Member
portalRouter.get('/leaves/:staffId', async (req, res) => {
    try {
        const { staffId } = req.params;
        const result = await pool.query('SELECT * FROM staff_leaves WHERE "staffId" = $1 ORDER BY "appliedOn" DESC', [staffId]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching leave history.' });
    }
});

// Get Timetable for a Staff Member
portalRouter.get('/timetable/:staffId', async (req, res) => {
    try {
        const { staffId } = req.params;
        const result = await pool.query('SELECT * FROM staff_timetables WHERE "staffId" = $1', [staffId]);
        res.json(result.rows);
    } catch (err) {
        console.error('Fetch Timetable Error:', err);
        res.status(500).json({ message: 'Error fetching timetable.' });
    }
});

portalRouter.get('/teacher-dashboard-data/:staffId', async (req, res) => {
    try {
        const { staffId } = req.params;
        const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const todayName = days[new Date().getDay()];

        const [timetableRes, staffRes] = await Promise.all([
            pool.query('SELECT * FROM staff_timetables WHERE "staffId" = $1 AND day = $2', [staffId, todayName]),
            pool.query('SELECT class_teacher, subjects FROM staff WHERE "staffId" = $1', [staffId])
        ]);

        const periodTimings = {
            period1: '09:00 AM',
            period2: '10:00 AM',
            period3: '11:15 AM',
            period4: '12:15 PM',
            period5: '02:00 PM',
            period6: '03:00 PM',
            period7: '04:00 PM'
        };

        let schedule = [];
        let classesToday = 0;

        if (timetableRes.rows.length > 0) {
            const row = timetableRes.rows[0];
            for (let i = 1; i <= 7; i++) {
                const key = `period${i}`;
                if (row[key]) {
                    classesToday++;
                    // Typical value format: "Maths (10-A)" or "Physics (12-B)"
                    const parts = row[key].split('(');
                    const subject = parts[0].trim();
                    const className = parts[1] ? parts[1].replace(')', '').trim() : 'N/A';

                    schedule.push({
                        time: periodTimings[key],
                        period: i,
                        subject: subject,
                        class: className
                    });
                }
            }
        }

        // Total Students logic - Expanded to check BOTH staff profile AND dynamic timetable
        let totalStudents = 0;
        const uniqueClasses = new Set();
        
        // 1. Check Staff Profile (Class Teacher role)
        if (staffRes.rows.length > 0) {
            const staff = staffRes.rows[0];
            if (staff.class_teacher) uniqueClasses.add(staff.class_teacher.trim());
        }

        // 2. Scan ALL WEEKLY TIMETABLE assignments (Subject Teacher roles)
        const weeklyTimetableRes = await pool.query('SELECT * FROM staff_timetables WHERE "staffId" = $1', [staffId]);
        weeklyTimetableRes.rows.forEach(dayRow => {
            for (let i = 1; i <= 7; i++) {
                const val = dayRow[`period${i}`];
                if (val && typeof val === 'string') {
                    // Extract class from format "Subject (Class-Section)" or "Subject (Class Section)"
                    const match = val.match(/\(([^)]+)\)/);
                    if (match) {
                        const classSection = match[1].replace('-', ' ').trim();
                        uniqueClasses.add(classSection);
                    }
                }
            }
        });

        // 3. Count students in the resulting deduplicated list
        if (uniqueClasses.size > 0) {
            for (const cls of uniqueClasses) {
                const parts = cls.split(' ');
                if (parts.length < 2) continue; // Skip invalid entries
                const section = parts.pop();
                const className = parts.join(' ');
                const countRes = await pool.query('SELECT COUNT(*) FROM students WHERE class = $1 AND section = $2', [className, section]);
                totalStudents += parseInt(countRes.rows[0].count);
            }
        }

        res.json({
            classesToday: classesToday > 0 ? classesToday.toString() : 'Not Allocated',
            schedule: schedule,
            totalStudents: totalStudents.toString()
        });
    } catch (err) {
        console.error('Teacher dash data error:', err);
        res.status(500).json({ message: 'Error fetching teacher dashboard data' });
    }
});

// Get Student Timetable
portalRouter.get('/timetable/student/:className/:section', async (req, res) => {
    try {
        const { className, section } = req.params;
        const result = await pool.query('SELECT * FROM student_timetables WHERE class_name = $1 AND section = $2', [className, section]);
        res.json(result.rows);
    } catch (err) {
        console.error('Fetch Student Timetable Error:', err);
        res.status(500).json({ message: 'Error fetching student timetable.' });
    }
});

// Notifications API
portalRouter.get('/notifications/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const result = await pool.query('SELECT * FROM notifications WHERE user_id = $1', [userId]);
        res.json(result.rows);
    } catch (err) {
        console.error('[NOTIFICATIONS ERROR]', err);
        res.status(500).json({ message: 'Error fetching notifications', details: err.message });
    }
});

portalRouter.patch('/notifications/read/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('UPDATE notifications SET is_read = true WHERE id = $1', [id]);
        res.json({ message: 'Notification marked as read' });
    } catch (err) {
        res.status(500).json({ message: 'Error updating notification' });
    }
});

// Get Students for a specific class and section
portalRouter.get('/students', async (req, res) => {
    try {
        const { className, section } = req.query;
        if (!className) {
            return res.status(400).json({ message: 'ClassName is required.' });
        }

        const query = `
            SELECT "studentId", "firstName", "lastName", class, section, email, "dateOfBirth"::text as dob, photo_url
            FROM students
            WHERE class = $1 ${section ? 'AND section = $2' : ''}
            ORDER BY "firstName" ASC
        `;
        const values = section ? [className, section] : [className];
        const result = await pool.query(query, values);
        res.json(result.rows);
    } catch (err) {
        console.error('Fetch Students Error:', err);
        res.status(500).json({ message: 'Error fetching students.' });
    }
});

// Get Marks for students in a class, section, subject
portalRouter.get('/marks', async (req, res) => {
    try {
        const { className, section, subject } = req.query;
        console.log(`[MARKS FETCH] Class: ${className}, Section: ${section}, Subject: ${subject}`);
        
        if (!className || !subject) {
            return res.status(400).json({ message: 'ClassName and Subject are required.' });
        }

        const query = `
            SELECT s."studentId", s."firstName", s."lastName", 
                   m1.marks as u1_marks, m1.remarks as u1_remarks,
                   m2.marks as u2_marks, m2.remarks as u2_remarks,
                   m3.marks as u3_marks, m3.remarks as u3_remarks
            FROM students s
            LEFT JOIN student_marks m1 ON s."studentId" = m1."studentId" AND m1.subject = $3 AND m1.exam_type = 'U1'
            LEFT JOIN student_marks m2 ON s."studentId" = m2."studentId" AND m2.subject = $3 AND m2.exam_type = 'U2'
            LEFT JOIN student_marks m3 ON s."studentId" = m3."studentId" AND m3.subject = $3 AND m3.exam_type = 'U3'
            WHERE s.class = $1 ${section ? 'AND s.section = $2' : ''}
            ORDER BY s."firstName" ASC
        `;
        const values = section ? [className, section, subject] : [className, '', subject];
        const result = await pool.query(query, values.filter(v => v !== undefined));
        res.json(result.rows);
    } catch (err) {
        console.error('Fetch Marks Error:', err);
        res.status(500).json({ message: 'Error fetching marks.' });
    }
});

// Get Attendance for students in a class, section, date
portalRouter.get('/class-counts', async (req, res) => {
    try {
        const { classes } = req.query; // Expecting comma separated or multiple
        if (!classes) return res.json({});

        const classList = Array.isArray(classes) ? classes : classes.split(',');

        const counts = {};
        for (const cls of classList) {
            const parts = cls.trim().split(' ');
            let className = '';
            let section = '';
            if (parts.length > 1) {
                section = parts.pop();
                className = parts.join(' ');
            } else {
                className = parts[0];
            }

            const result = await pool.query(
                'SELECT COUNT(*) FROM students WHERE class = $1 AND section = $2',
                [className, section]
            );
            counts[cls] = parseInt(result.rows[0].count);
        }
        res.json(counts);
    } catch (err) {
        console.error('Count Error:', err);
        res.status(500).json({ message: 'Error fetching counts' });
    }
});

portalRouter.get('/attendance', async (req, res) => {
    try {
        const { className, section, date } = req.query;
        if (!className || !date) {
            return res.status(400).json({ message: 'ClassName and Date are required.' });
        }

        const query = `
            SELECT s."studentId", s."firstName", s."lastName", a.status, a.remarks
            FROM students s
            LEFT JOIN student_attendance a ON s."studentId" = a."studentId" AND a.date = $3
            WHERE s.class = $1 AND s.section = $2
            ORDER BY s."firstName" ASC
        `;
        const result = await pool.query(query, [className, section, date]);
        res.json(result.rows);
    } catch (err) {
        console.error('Fetch Attendance Error:', err);
        res.status(500).json({ message: 'Error fetching attendance.' });
    }
});

// Save Attendance (Upsert)
// Fetch Relevant Announcements
portalRouter.get('/announcements', async (req, res) => {
    try {
        const { role, class: className, userId } = req.query;
        if (!role) return res.status(400).json({ message: 'Role is required' });

        // Build filtering conditions
        // Everyone sees 'all'
        // Teachers see 'teachers'
        // Students see 'students'
        // If className is provided, see 'class' matching className
        // Users also see announcements they SENT

        const conditions = ["target_type = 'all'"];

        if (role === 'teacher') {
            conditions.push("target_type = 'teachers'");
        } else if (role === 'student') {
            conditions.push("target_type = 'students'");
        }

        if (className) {
            conditions.push(`(target_type = 'class' AND target_class = '${className}')`);
        }

        if (userId) {
            conditions.push(`sender_id = '${userId}'`);
        }

        const query = `
            SELECT * FROM announcements 
            WHERE ${conditions.join(' OR ')}
            ORDER BY created_at DESC
        `;

        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error('Fetch Announcements Error:', err);
        res.status(500).json({ message: 'Error fetching announcements' });
    }
});

// Create Announcement
portalRouter.post('/announcements', async (req, res) => {
    try {
        const { sender_id, sender_name, sender_role, target_type, target_class, title, message, type } = req.body;

        if (!sender_id || !title || !message) {
            return res.status(400).json({ message: 'Missing required fields' });
        }

        // Rule 1: Character limits (25 for subject, 75 for message)
        if (title.length > 25) return res.status(400).json({ message: 'Subject exceeds 25 characters.' });
        if (message.length > 75) return res.status(400).json({ message: 'Message exceeds 75 characters.' });

        await pool.query(`
            INSERT INTO announcements (sender_id, sender_name, sender_role, target_type, target_class, title, message, type)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [sender_id, sender_name, sender_role, target_type, target_class, title, message, type || 'info']);

        res.json({ message: 'Announcement posted successfully' });
    } catch (err) {
        console.error('Post Announcement Error:', err);
        res.status(500).json({ message: 'Error posting announcement' });
    }
});

// Delete Announcement (Rule 2: Delete option only to who posted)
portalRouter.delete('/announcements/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { userId, role } = req.query;

        const result = await pool.query('SELECT sender_id, sender_role FROM announcements WHERE id = $1', [id]);
        if (result.rows.length === 0) return res.status(404).json({ message: 'Not found' });

        const ann = result.rows[0];

        // 1. Admin can delete any 'admin' announcement
        // 2. The original poster can delete their own
        const isAuthor = (ann.sender_id === userId);
        const isAdminOverAdmin = (role === 'admin' && ann.sender_role === 'admin');

        if (!isAuthor && !isAdminOverAdmin) {
            return res.status(403).json({ message: 'Only the sender can delete this' });
        }

        await pool.query('DELETE FROM announcements WHERE id = $1', [id]);
        res.json({ message: 'Announcement deleted successfully' });
    } catch (err) {
        console.error('Delete Announcement Error:', err);
        res.status(500).json({ message: 'Error deleting announcement' });
    }
});

// Rule 3: Auto-delete after 5 days
const cleanupAnnouncements = async () => {
    try {
        console.log('[CLEANUP] Removing announcements older than 5 days...');
        await pool.query("DELETE FROM announcements WHERE created_at < NOW() - INTERVAL '5 days'");
    } catch (err) {
        console.error('Cleanup Error:', err);
    }
};

// Run cleanup every hour
setInterval(cleanupAnnouncements, 1000 * 60 * 60);
// Run once on startup
cleanupAnnouncements();

portalRouter.post('/attendance', async (req, res) => {
    let client;
    try {
        const { records } = req.body;
        if (!records || !Array.isArray(records) || records.length === 0) {
            return res.status(200).json({ message: 'No records provided. Day remains unmarked (Holiday).' });
        }

        const sample = records[0];
        const { className, section, date, staffId } = sample;

        client = await pool.connect();
        await client.query('BEGIN');

        // 1. Get all students for this class/section
        const classStudentsRes = await client.query(
            'SELECT "studentId" FROM students WHERE class = $1 AND section = $2',
            [className, section]
        );
        const classStudentIds = classStudentsRes.rows.map(r => r.studentId);
        const submittedStudentIds = records.map(r => r.studentId);

        // 2. Upsert submitted records
        for (const record of records) {
            const { studentId, status, remarks } = record;
            const upsertQuery = `
                INSERT INTO student_attendance ("studentId", class, section, date, status, remarks, "submitted_by")
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                ON CONFLICT ("studentId", date)
                DO UPDATE SET status = EXCLUDED.status, remarks = EXCLUDED.remarks, created_at = CURRENT_TIMESTAMP
            `;
            await client.query(upsertQuery, [studentId, className, section, date, status, remarks, staffId]);
        }

        // 3. Mark missing students as 'Absent' (Bulk Absent Logic)
        const missingStudentIds = classStudentIds.filter(id => !submittedStudentIds.includes(id));
        for (const studentId of missingStudentIds) {
            const absentQuery = `
                INSERT INTO student_attendance ("studentId", class, section, date, status, "submitted_by")
                VALUES ($1, $2, $3, $4, 'Absent', $5)
                ON CONFLICT ("studentId", date)
                DO UPDATE SET status = EXCLUDED.status, created_at = CURRENT_TIMESTAMP
            `;
            await client.query(absentQuery, [studentId, className, section, date, staffId]);
        }

        await client.query('COMMIT');
        res.json({ message: 'Attendance updated successfully. Missing students marked as Absent.' });
    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error('Save Attendance Error:', err);
        res.status(500).json({ message: 'Error saving attendance.' });
    } finally {
        if (client) client.release();
    }
});

// GET System Settings
portalRouter.get('/settings', async (req, res) => {
    try {
        const result = await pool.query('SELECT "key", value FROM system_settings');
        const settings = {};
        result.rows.forEach(r => settings[r.key] = r.value);
        res.json(settings);
    } catch (err) {
        console.error('Fetch Settings Error:', err);
        res.status(500).json({ message: 'Error fetching settings.' });
    }
});

// POST Update System Settings (Admin only action)
portalRouter.post('/settings', async (req, res) => {
    try {
        const { key, value } = req.body;
        if (!key) return res.status(400).json({ message: 'Setting key is required.' });

        await pool.query(`
            INSERT INTO system_settings ("key", value, updated_at)
            VALUES ($1, $2, CURRENT_TIMESTAMP)
            ON CONFLICT ("key") DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP
        `, [key, value]);

        res.json({ message: `Setting ${key} updated successfully.` });
    } catch (err) {
        console.error('Update Setting Error:', err);
        res.status(500).json({ message: 'Error updating setting.' });
    }
});

// Homework Logic
portalRouter.get('/homework', async (req, res) => {
    try {
        const { teacherId, className, section } = req.query;
        let query = 'SELECT * FROM homework ';
        let params = [];

        if (teacherId) {
            query += 'WHERE teacher_id = $1 ';
            params.push(teacherId);
        } else if (className) {
            query += 'WHERE class_name = $1 AND section = $2 ';
            params.push(className, section || '');
        }

        query += 'ORDER BY created_at DESC';
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error('Fetch Homework Error:', err);
        res.status(500).json({ message: 'Error fetching homework.' });
    }
});

portalRouter.post('/homework', (req, res, next) => {
    console.log('[DEBUG] Starting homework post upload');
    upload.array('files', 5)(req, res, (err) => {
        if (err) {
            console.error('[DEBUG] Multer Upload Error:', err);
            return res.status(500).json({ 
                message: 'File upload error reaching Cloudinary.',
                error: err.message,
                details: 'This often happens if Cloudinary credentials in .env are invalid or network is blocked.' 
            });
        }
        next();
    });
}, async (req, res) => {
    try {
        const { teacherId, className, section, subject, title, description, dueDate } = req.body;
        console.log('[DEBUG] Form data received:', { teacherId, className, section, subject, title, dueDate });
        
        // Backend Validation
        if (!teacherId || !className || !subject || !title || !dueDate) {
            return res.status(400).json({ message: 'Missing mandatory fields: Class, Subject, Title, or Due Date.' });
        }
        if (title.length > 30) return res.status(400).json({ message: 'Title exceeds 30 characters.' });
        if (description && description.length > 75) return res.status(400).json({ message: 'Description exceeds 75 characters.' });
        if (!description && (!req.files || req.files.length === 0)) {
            return res.status(400).json({ message: 'Please provide either a description or at least one attachment.' });
        }

        const fileUrls = req.files ? req.files.map(f => f.path).join(',') : '';

        const query = `
            INSERT INTO homework (teacher_id, class_name, section, subject, title, description, attachments, due_date)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING *
        `;
        const result = await pool.query(query, [
            teacherId, className, section, subject, title, description, fileUrls, dueDate
        ]);

        res.status(201).json(result.rows[0]);

        // Background: Send Notifications to Students
        try {
            const hw = result.rows[0];
            // Find all students in this class/section
            const studentQuery = `
                SELECT "studentId" FROM students 
                WHERE LOWER(class) = LOWER($1) AND (LOWER(section) = LOWER($2) OR $2 = '')
                   OR LOWER(class || ' ' || section) = LOWER($1 || ' ' || $2)
            `;
            const students = await pool.query(studentQuery, [className, section]);
            
            for (const s of students.rows) {
                await pool.query(
                    'INSERT INTO notifications (user_id, title, message) VALUES ($1, $2, $3)',
                    [s.studentId, 'New Homework: ' + title, `A new assignment for ${subject} has been posted. Due: ${dueDate}`]
                );
            }
        } catch (notifErr) {
            console.error('Notification Error:', notifErr);
        }
    } catch (err) {
        console.error('Create Homework FULL ERROR:', err);
        res.status(500).json({ 
            message: 'Error assigning homework.', 
            error: err.message,
            detail: err.detail || 'Check server console for details'
        });
    }
});

// Helper: Extract Cloudinary Public ID from URL
const extractPublicId = (url) => {
    try {
        if (!url || typeof url !== 'string') return null;
        const parts = url.split('/');
        const uploadIndex = parts.indexOf('upload');
        if (uploadIndex === -1) return null;
        // Public ID is everything after the version (e.g. /upload/v1234/[folder/file.pdf])
        const publicIdWithExt = parts.slice(uploadIndex + 2).join('/');
        return publicIdWithExt.split('.')[0]; // remove file extension
    } catch (e) { return null; }
};

portalRouter.delete('/homework/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { teacherId } = req.query;

        // 1. Fetch the homework first to get attachment URLs
        const findRes = await pool.query('SELECT attachments FROM homework WHERE id = $1 AND teacher_id = $2', [id, teacherId]);
        if (findRes.rows.length === 0) {
            return res.status(404).json({ message: 'Homework not found or unauthorized.' });
        }

        const attachments = findRes.rows[0].attachments;

        // 2. Delete database record
        await pool.query('DELETE FROM homework WHERE id = $1', [id]);

        // 3. Background: Cleanup Cloudinary Files
        if (attachments) {
            const urls = attachments.split(',');
            for (const url of urls) {
                const publicId = extractPublicId(url);
                if (publicId) {
                    cloudinary.uploader.destroy(publicId, { resource_type: 'auto' }).catch(err => {
                        console.error('Cloudinary Cleanup Warning:', err);
                    });
                }
            }
        }

        res.json({ message: 'Homework and attachments deleted successfully.' });
    } catch (err) {
        console.error('Delete Homework Error:', err);
        res.status(500).json({ message: 'Error deleting homework.' });
    }
});

// --- Homework Submission System (Student Side) ---

// Student Submits PDF
portalRouter.post('/homework/submit', upload.single('file'), async (req, res) => {
    try {
        const { homeworkId, studentId, studentName } = req.body;
        if (!req.file) return res.status(400).json({ message: 'No submission file (PDF) provided.' });

        // 1. Cleanup old file if it exists (before updating)
        try {
            const oldSubRes = await pool.query('SELECT submission_url FROM homework_submissions WHERE homework_id = $1 AND "studentId" = $2', [homeworkId, studentId]);
            if (oldSubRes.rows.length > 0) {
                const oldUrl = oldSubRes.rows[0].submission_url;
                const publicId = extractPublicId(oldUrl);
                if (publicId) {
                    cloudinary.uploader.destroy(publicId, { resource_type: 'auto' }).catch(err => console.error('Cloudinary Old Sub Cleanup Error:', err));
                }
            }
        } catch (cleanupErr) {
            console.error('Submission Cleanup Error (Skipped):', cleanupErr);
        }

        const query = `
            INSERT INTO homework_submissions (homework_id, "studentId", student_name, submission_url)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (homework_id, "studentId") 
            DO UPDATE SET submission_url = EXCLUDED.submission_url, submitted_at = CURRENT_TIMESTAMP
            RETURNING *
        `;
        const result = await pool.query(query, [homeworkId, studentId, studentName, req.file.path]);
        res.json({ message: 'Homework submitted successfully!', submission: result.rows[0] });
    } catch (err) {
        console.error('Submission Error:', err);
        res.status(500).json({ message: 'Error submitting homework.' });
    }
});

// Teacher views all submissions for a task
portalRouter.get('/homework/submissions/:homeworkId', async (req, res) => {
    try {
        const { homeworkId } = req.params;
        const result = await pool.query(
            'SELECT * FROM homework_submissions WHERE homework_id = $1 ORDER BY submitted_at DESC',
            [homeworkId]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching submissions.' });
    }
});

// Teacher grades a submission
portalRouter.patch('/homework/grade/:submissionId', async (req, res) => {
    try {
        const { submissionId } = req.params;
        const { grade, feedback } = req.body;
        
        const result = await pool.query(
            'UPDATE homework_submissions SET grade = $1, feedback = $2 WHERE id = $3 RETURNING *',
            [grade, feedback, submissionId]
        );
        const entry = result.rows[0];
        res.json(entry);

        // Background: Send Notification to Student
        try {
            await pool.query(
                'INSERT INTO notifications (user_id, title, message) VALUES ($1, $2, $3)',
                [entry.studentId, 'Homework Graded', `Your submission for homework #${entry.homework_id} has been graded. Grade: ${grade}`]
            );
        } catch (notifErr) {
            console.error('Grading Notification Error:', notifErr);
        }
    } catch (err) {
        res.status(500).json({ message: 'Error saving grade.' });
    }
});

// Student grades a submission (existing PATCH grade was above)
// ...

// Student views their class homework + their submission status
portalRouter.get('/homework/student-view/:studentId', async (req, res) => {
    try {
        const { studentId } = req.params;
        
        // 1. Get student's class and section
        const studentRes = await pool.query('SELECT class, section FROM students WHERE "studentId" = $1', [studentId]);
        if (studentRes.rows.length === 0) return res.status(404).json({ message: 'Student not found.' });
        
        const { class: studentClass, section: studentSection } = studentRes.rows[0];
        console.log(`[DEBUG] Fetching homework for Student: ${studentId}, Class: "${studentClass}", Section: "${studentSection}"`);

        // 2. Get all homework for this class/section
        // We match by:
        // (Table Class == Student Class AND Table Section == Student Section)
        // OR (Table Class contains Student Class AND Table Class contains Student Section) - for cases where teacher saved combined "10th Std A" as class
        const homeworkQuery = `
            SELECT * FROM homework 
            WHERE (LOWER(class_name) = LOWER($1) AND LOWER(section) = LOWER($2))
               OR (LOWER(class_name) = LOWER($1 || ' ' || $2) AND section = '')
               OR (LOWER(class_name) = LOWER($1 || '-' || $2) AND section = '')
            ORDER BY created_at DESC
        `;
        const homeworkRes = await pool.query(homeworkQuery, [studentClass, studentSection]);
        console.log(`[DEBUG] Found ${homeworkRes.rows.length} assignments.`);

        // 3. Get student's submissions for these assignments
        const submissionsRes = await pool.query(
            'SELECT homework_id, grade, submission_url, submitted_at FROM homework_submissions WHERE "studentId" = $1',
            [studentId]
        );

        // Merge data
        const homeworks = homeworkRes.rows.map(hw => {
            const submission = submissionsRes.rows.find(s => s.homework_id === hw.id);
            return {
                ...hw,
                submission: submission || null
            };
        });

        res.json(homeworks);
    } catch (err) {
        console.error('Fetch Student View Error:', err);
        res.status(500).json({ message: 'Error fetching homework assignments.' });
    }
});

// --- End Homework Submission System ---

// Save Marks (Upsert)
portalRouter.post('/marks', async (req, res) => {
    let client;
    try {
        const { records } = req.body;
        if (!records || !Array.isArray(records)) {
            return res.status(400).json({ message: 'Invalid marks records.' });
        }

        client = await pool.connect();
        await client.query('BEGIN');

        for (const record of records) {
            const { studentId, className, section, subject, examType, marks, remarks, staffId } = record;
            const upsertQuery = `
                INSERT INTO student_marks ("studentId", class, section, subject, exam_type, marks, remarks, submitted_by)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                ON CONFLICT ("studentId", subject, exam_type)
                DO UPDATE SET marks = EXCLUDED.marks, remarks = EXCLUDED.remarks, submitted_by = EXCLUDED.submitted_by, created_at = CURRENT_TIMESTAMP
            `;
            await client.query(upsertQuery, [studentId, className, section, subject, examType, marks, remarks, staffId]);
        }

        await client.query('COMMIT');
        res.json({ message: 'Marks updated successfully.' });
    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error('Save Marks Error:', err);
        res.status(500).json({ message: 'Error saving marks.' });
    } finally {
        if (client) client.release();
    }
});

// GET Student Attendance for a specific month (student self-view)
portalRouter.get('/student-attendance/:studentId', async (req, res) => {
    try {
        const { studentId } = req.params;
        const { month, year } = req.query;

        let query;
        let values;

        if (month && year) {
            query = `
                SELECT date::text, status, remarks
                FROM student_attendance
                WHERE "studentId" = $1
                  AND EXTRACT(MONTH FROM date) = $2
                  AND EXTRACT(YEAR FROM date) = $3
                ORDER BY date ASC
            `;
            values = [studentId, parseInt(month), parseInt(year)];
        } else {
            // Default: current month
            query = `
                SELECT date::text, status, remarks
                FROM student_attendance
                WHERE "studentId" = $1
                  AND EXTRACT(MONTH FROM date) = EXTRACT(MONTH FROM CURRENT_DATE)
                  AND EXTRACT(YEAR FROM date) = EXTRACT(YEAR FROM CURRENT_DATE)
                ORDER BY date ASC
            `;
            values = [studentId];
        }

        const result = await pool.query(query, values);
        res.json(result.rows);
    } catch (err) {
        console.error('Student Attendance Fetch Error:', err);
        res.status(500).json({ message: 'Error fetching student attendance.' });
    }
});

portalRouter.get('/student-fees/:studentId', async (req, res) => {
    try {
        const { studentId } = req.params;
        const studentRes = await pool.query('SELECT class, "pendingFee" FROM students WHERE "studentId" = $1', [studentId]);
        
        if (studentRes.rows.length === 0) {
            return res.status(404).json({ message: 'Student not found' });
        }

        const student = studentRes.rows[0];
        const feesRes = await pool.query('SELECT * FROM class_fees WHERE class_name = $1', [student.class]);
        const feesData = feesRes.rows;

        const totalAnnual = feesData.reduce((sum, f) => sum + parseFloat(f.amount || 0), 0);
        const pending = parseFloat(student.pendingFee || 0);
        const paid = Math.max(0, totalAnnual - pending);

        res.json({
            stats: {
                annual: `₹${totalAnnual.toLocaleString()}`,
                paid: `₹${paid.toLocaleString()}`,
                pending: `₹${pending.toLocaleString()}`
            },
            breakdown: feesData.map(f => ({
                name: f.fee_name,
                period: f.due_date ? `Due: ${new Date(f.due_date).toLocaleDateString()}` : 'Annual',
                amount: `₹${parseFloat(f.amount).toLocaleString()}`
            })),
            totalAnnualStr: `₹${totalAnnual.toLocaleString()}`
        });
    } catch (err) {
        console.error('Fetch student fees error:', err);
        res.status(500).json({ message: 'Error fetching fee data' });
    }
});

// GET Student Marks with Teacher Name (student self-view)
portalRouter.get('/student-marks/:studentId', async (req, res) => {
    try {
        const { studentId } = req.params;
        const query = `
            SELECT 
                m.subject,
                m.exam_type,
                m.marks,
                m.remarks,
                m.created_at,
                COALESCE(s."firstName" || ' ' || s."lastName", 'N/A') AS teacher_name
            FROM student_marks m
            LEFT JOIN staff s ON s."staffId" = m.submitted_by
            WHERE m."studentId" = $1
            ORDER BY m.subject ASC, m.exam_type ASC
        `;
        const result = await pool.query(query, [studentId]);
        res.json(result.rows);
    } catch (err) {
        console.error('Student Marks Fetch Error:', err);
        res.status(500).json({ message: 'Error fetching student marks.' });
    }
});

// GET recent chat contacts for a user with unread counts
portalRouter.get('/messages/recent/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        console.log(`[MSG DEBUG] Fetching recent contacts for: ${userId}`);
        const result = await pool.query(`
            SELECT 
                m.other_id, 
                m.message, 
                m.created_at, 
                u.role, 
                u.name,
                (SELECT COUNT(*)::int FROM portal_messages 
                 WHERE receiver_id = $1 AND sender_id = m.other_id AND is_read = false) as unread_count
            FROM (
                SELECT DISTINCT ON (other_id) 
                    CASE WHEN sender_id = $1 THEN receiver_id ELSE sender_id END as other_id,
                    message, created_at
                FROM portal_messages
                WHERE sender_id = $1 OR receiver_id = $1
                ORDER BY other_id, created_at DESC
            ) m
            LEFT JOIN (
                SELECT "studentId" as sid, 'student' as role, "firstName" || ' ' || "lastName" as name FROM students
                UNION ALL
                SELECT "staffId" as sid, 'teacher' as role, "firstName" || ' ' || "lastName" as name FROM staff
            ) u ON u.sid = m.other_id
            ORDER BY m.created_at DESC
        `, [userId]);
        res.json(result.rows);
    } catch (err) {
        console.error('Fetch Contacts Error:', err);
        res.status(500).json({ message: 'Error fetching recent contacts.' });
    }
});

// GET conversation between two specific users
portalRouter.get('/messages/:userId/:otherId', async (req, res) => {
    try {
        const { userId, otherId } = req.params;
        console.log(`[MSG DEBUG] Fetching messages: ${userId} <-> ${otherId}`);
        const result = await pool.query(
            'SELECT * FROM portal_messages WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1) ORDER BY created_at ASC',
            [userId, otherId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Fetch Messages Error:', err);
        res.status(500).json({ message: 'Error fetching messages.' });
    }
});

// POST send a message
portalRouter.post('/messages', async (req, res) => {
    try {
        const { sender_id, receiver_id, message } = req.body;
        console.log(`[MSG DEBUG] Sending message: ${sender_id} -> ${receiver_id}`);
        if (!sender_id || !receiver_id || !message) {
            return res.status(400).json({ message: 'Missing fields.' });
        }
        const result = await pool.query(
            'INSERT INTO portal_messages (sender_id, receiver_id, message) VALUES ($1, $2, $3) RETURNING *',
            [sender_id, receiver_id, message]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('Send Message Error:', err);
        res.status(500).json({ message: 'Error sending message.' });
    }
});

// PATCH mark messages as read
portalRouter.patch('/messages/read/:userId/:otherId', async (req, res) => {
    try {
        const { userId, otherId } = req.params;
        console.log(`[MSG DEBUG] Marking as read: ${otherId} -> ${userId}`);
        await pool.query(
            'UPDATE portal_messages SET is_read = true WHERE receiver_id = $1 AND sender_id = $2 AND is_read = false',
            [userId, otherId]
        );
        res.json({ message: 'Messages marked as read.' });
    } catch (err) {
        console.error('Read Receipt Error:', err);
        res.status(500).json({ message: 'Error marking messages as read.' });
    }
});

// DELETE a message (delete for everyone)
portalRouter.delete('/messages/:id', async (req, res) => {
    try {
        const { id } = req.params;
        console.log(`[MSG DEBUG] Deleting message ID: ${id}`);
        await pool.query('DELETE FROM portal_messages WHERE id = $1', [id]);
        res.json({ message: 'Message deleted successfully.' });
    } catch (err) {
        console.error('Delete Message Error:', err);
        res.status(500).json({ message: 'Error deleting message.' });
    }
});

// GET students by name search (for messaging)
portalRouter.get('/students/search', async (req, res) => {
    try {
        const { q } = req.query;
        if (!q) return res.json([]);
        const result = await pool.query(
            "SELECT * FROM students WHERE \"firstName\" ILIKE $1 OR \"lastName\" ILIKE $1",
            [`%${q}%`]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Student Search Error:', err);
        res.status(500).json({ message: 'Error searching students.' });
    }
});

// GET staff by name search (for messaging)
portalRouter.get('/staff/search', async (req, res) => {
    try {
        const { q } = req.query;
        if (!q) return res.json([]);
        const result = await pool.query(
            "SELECT * FROM staff WHERE \"firstName\" ILIKE $1 OR \"lastName\" ILIKE $1",
            [`%${q}%`]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Staff Search Error:', err);
        res.status(500).json({ message: 'Error searching staff.' });
    }
});
// GET documents for a user
portalRouter.get('/documents/:role/:userId', async (req, res) => {
    try {
        const { role, userId } = req.params;
        const result = await pool.query(
            'SELECT * FROM user_documents WHERE user_id = $1 AND role = $2 ORDER BY uploaded_at DESC',
            [userId, role]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Fetch Documents Error:', err);
        res.status(500).json({ message: 'Error fetching documents.' });
    }
});

// POST upload a document
portalRouter.post('/documents/upload', upload.single('file'), async (req, res) => {
    try {
        const { userId, role, filename } = req.body;
        
        if (!req.file || !userId || !role) {
            return res.status(400).json({ message: 'Missing file or user information.' });
        }

        const query = `
            INSERT INTO user_documents (user_id, role, filename, file_url, cloudinary_id, size)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
        `;
        const result = await pool.query(query, [
            userId,
            role,
            filename || req.file.originalname,
            req.file.path, // This is the Cloudinary URL
            req.file.filename, // This is the public_id in Cloudinary
            req.file.size
        ]);

        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('Upload Error:', err);
        res.status(500).json({ message: 'Error uploading file.' });
    }
});

// DELETE a document
portalRouter.delete('/documents/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { userId, role } = req.query; // Security: verify ownership

        // 1. Check ownership
        const docResult = await pool.query('SELECT * FROM user_documents WHERE id = $1', [id]);
        if (docResult.rows.length === 0) return res.status(404).json({ message: 'Document not found.' });
        
        const doc = docResult.rows[0];
        if (doc.user_id !== userId || doc.role !== role) {
            return res.status(403).json({ message: 'Permission denied. Only owner can delete.' });
        }

        // 2. Delete from Cloudinary
        await cloudinary.uploader.destroy(doc.cloudinary_id);

        // 3. Delete from Database
        await pool.query('DELETE FROM user_documents WHERE id = $1', [id]);

        res.json({ message: 'Document deleted successfully.' });
    } catch (err) {
        console.error('Delete Document Error:', err);
        res.status(500).json({ message: 'Error deleting document.' });
    }
});

// Catch-all for portal router (if no route matched)
portalRouter.use((req, res) => {
    console.log(`[PORTAL 404] No route found for: ${req.method} ${req.url}`);
    res.status(404).json({ message: `Portal route not found: ${req.method} ${req.url}` });
});

app.use('/api/portal', portalRouter);

app.get('/', (req, res) => {
    res.send('XAN Portal Server is Online');
});

app.listen(port, () => {
    console.log(`Portal Server running on port: ${port}`);
});
