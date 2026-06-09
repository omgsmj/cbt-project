// 1. 필수 라이브러리 로드
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config(); // .env 파일의 보안 정보 로드

const app = express();
const PORT = process.env.PORT || 3000;

// 2. 미들웨어 설정 (서버 통신 규격 세팅)
app.use(cors()); // 프론트엔드 브라우저의 CORS 차단 정책 해제
app.use(express.json()); // 브라우저가 보낸 JSON 데이터를 자바스크립트 객체로 파싱
// 서버가 현재 폴더에 있는 HTML 파일들을 브라우저에 직접 보내주도록 설정하는 마법의 코드
app.use(express.static(__dirname));
// 3. PostgreSQL 데이터베이스 연결 설정 (커넥션 풀 생성)
const pool = new Pool({
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_DATABASE
});

const path = require('path'); // 파일 경로를 다루는 도구

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
}); // ➔ 여기에 중괄호 '}'와 소괄호 ')'가 정확히 닫혀야 에러가 나지 않습니다!

// ----------------------------------------------------
// [API 1] 기출문제 조회 통로 (GET /api/questions?session=1)
// ----------------------------------------------------
app.get('/api/questions', async (req, res) => {
    const sessionNum = req.query.session; // URL 뒤에 붙은 ?session=1 번호 추출
    
    if(!sessionNum) {
        return res.status(400).json({ error: "회차 번호(session)가 누적되지 않았습니다." });
    }

    try {
        // SQL 실행하여 해당 회차의 문제를 번호 순서대로 가져옴
        const result = await pool.query(
            'SELECT id, session, number, subject, question, options, answer FROM questions WHERE session = $1 ORDER BY number ASC',
            [sessionNum]
        );
        res.json(result.rows); // 조회된 행 리스트를 프론트엔드로 전송
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "데이터베이스 조회 중 오류가 발생했습니다." });
    }
});

// ----------------------------------------------------
// [API 2] 모의고사 결과 제출 및 오답 저장 통로 (POST /api/results)
// ----------------------------------------------------
app.post('/api/results', async (req, res) => {
    // 프론트엔드가 body에 담아 보낸 포맷 데이터 추출
    const { folderName, examTitle, score, result, wrongQuestions } = req.body;

    // 데이터가 꼬이는 것을 방지하기 위해 PostgreSQL의 트랜잭션(Transaction) 기능 가동
    const client = await pool.connect();
    try {
        await client.query('BEGIN'); // ★ 채점 데이터 일괄 저장 시작 (안전장치)

        // A. 부모 테이블(exam_histories)에 폴더 요약 데이터 먼저 삽입 및 방금 생성된 ID 반환받기
        const historyResult = await client.query(
            'INSERT INTO exam_histories (folder_name, exam_title, score, result) VALUES ($1, $2, $3, $4) RETURNING id',
            [folderName, examTitle, score, result]
        );
        const newHistoryId = historyResult.rows[0].id; // 새로 만들어진 부모 폴더 고유 번호

        // B. 자식 테이블(wrong_answers)에 루프를 돌며 틀린 문제들을 연달아 삽입
        if (wrongQuestions && wrongQuestions.length > 0) {
            for (let q of wrongQuestions) {
                // 기존 기출문제 마스터 id를 찾기 위해 회차와 문제번호 조건으로 서브쿼리 활용 가능하지만, 
                // 여기서는 프론트엔드가 준 번호 기반 매핑 처리 수행
                const qSelect = await client.query(
                    'SELECT id FROM questions WHERE session = $1 AND number = $2',
                    [q.session, q.number]
                );
                
                if(qSelect.rows.length > 0) {
                    const originalQuestionId = qSelect.rows[0].id;
                    await client.query(
                        'INSERT INTO wrong_answers (history_id, question_id, user_answer) VALUES ($1, $2, $3)',
                        [newHistoryId, originalQuestionId, q.userAnswer]
                    );
                }
            }
        }

        await client.query('COMMIT'); // ★ 모든 데이터가 완벽히 저장되었으므로 확정 반영
        res.json({ success: true, message: "시험 결과 및 오답노트가 안전하게 DB에 보관되었습니다." });

    } catch (err) {
        await client.query('ROLLBACK'); // ❌ 도중에 에러가 하나라도 나면 전부 취소하고 백업 상태로 롤백
        console.error(err);
        res.status(500).json({ error: "채점 데이터 저장 중 트랜잭션 에러가 발생하여 취소되었습니다." });
    } finally {
        client.release(); // 사용한 DB 연결 끈 반납
    }
});

// ----------------------------------------------------
// [API 3] 폴더별 오답노트 목록 통합 조회 통로 (GET /api/histories)
// ----------------------------------------------------
app.get('/api/histories', async (req, res) => {
    try {
        // 테이블 조인(JOIN)을 사용하여 부모 폴더 정보와 자식 오답 상세, 기출문제 원본 내용까지 한 번에 결합해서 가져옴
        const sql = `
            SELECT 
                eh.id AS history_id, eh.folder_name, eh.exam_title, eh.score, eh.result,
                wa.user_answer,
                q.session, q.number, q.subject, q.question, q.options, q.answer AS correct_answer
            FROM exam_histories eh
            LEFT JOIN wrong_answers wa ON eh.id = wa.history_id
            LEFT JOIN questions q ON wa.question_id = q.id
            ORDER BY eh.created_at DESC, q.number ASC
        `;
        const result = await pool.query(sql);
        
        // 데이터 구조화: 테이블 조인으로 인한 평면적인 데이터를 프론트엔드가 쓰기 편하게 '폴더 내부 배열 계층형' 구조로 가공
        const historiesMap = {};
        result.rows.forEach(row => {
            if (!historiesMap[row.history_id]) {
                historiesMap[row.history_id] = {
                    id: row.history_id,
                    folderName: row.folder_name,
                    examTitle: row.exam_title,
                    score: row.score,
                    result: row.result,
                    questions: []
                };
            }
            // 틀린 문제가 매핑되어 있는 경우에만 배열에 주입
            if (row.number) {
                historiesMap[row.history_id].questions.push({
                    session: row.session,
                    number: row.number,
                    subject: row.subject,
                    question: row.question,
                    options: row.options,
                    answer: row.correct_answer,
                    userAnswer: row.user_answer
                });
            }
        });

        // 오브젝트 맵을 깔끔한 순수 배열로 변환하여 반환
        res.json(Object.values(historiesMap));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "오답노트 기록 로드 중 에러 발생" });
    }
});

// ----------------------------------------------------
// [API 4] 오답노트 폴더 통째로 직접 삭제 통로 (DELETE /api/histories/:id)
// ----------------------------------------------------
app.delete('/api/histories/:id', async (req, res) => {
    const historyId = req.params.id; // URL 주소창에 실려 온 고유 ID 값 추출

    try {
        // ON DELETE CASCADE 제약을 걸어두었기 때문에, 부모 행만 지우면 자식 wrong_answers 데이터는 트리거로 자동 삭제됩니다.
        await pool.query('DELETE FROM exam_histories WHERE id = $1', [historyId]);
        res.json({ success: true, message: "해당 회차 폴더와 오답 목록이 DB에서 영구 삭제되었습니다." });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "폴더 삭제 작업 수행 중 에러 발생" });
    }
});

// 4. 서버 바인딩 가동
app.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(`🎯 CBT Back-End Server가 http://localhost:${PORT} 에서 활성화되었습니다.`);
    console.log(`====================================================`);
});