const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const express = require('express');

// MySQL 데이터베이스 설정
const dbConfig = {
    host: '127.0.0.1',
    user: 'root',
    password: 'uimd5191!',
};

// Express 애플리케이션 생성
const app = express();

// 파일 읽기 함수
async function readFileContent(filePath) {
    return new Promise((resolve, reject) => {
        fs.readFile(filePath, 'utf8', (err, data) => {
            if (err) reject(err);
            resolve(data);
        });
    });
}

// 스키마 존재 여부 확인 및 생성
async function ensureSchemaExists(connection, schemaName) {
    try {
        const [rows] = await connection.query(
            `SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?`,
            [schemaName]
        );

        if (rows.length === 0) {
            console.log(`스키마 ${schemaName} 생성 중...`);
            await connection.query(`CREATE SCHEMA ${schemaName}`);
        } else {
            console.log(`스키마 ${schemaName}는 이미 존재합니다.`);
        }

        await connection.query(`USE ${schemaName}`);
    } catch (err) {
        console.error(`스키마 확인 중 오류 발생: ${err.message}`);
        // throw err;
    }
}

// 테이블 동기화 (컬럼 삭제 및 추가)
async function syncColumns(connection, tableName, createTableQuery) {
    // 정규 표현식 수정: 테이블 생성 쿼리에서 컬럼 이름과 정의를 추출
    const columnRegex = /(?:`?(\w+)`?\s+([^,]+))(?:,\s*)?/g;
    const requiredColumns = [];
    let match;
    console.log('tableName', tableName)
    // CREATE TABLE 쿼리에서 필요한 컬럼 추출
    while ((match = columnRegex.exec(createTableQuery)) !== null) {
        const columnName = match[1];
        let columnDefinition = match[2]?.trim();

        // 컬럼 정의에서 불필요한 공백이나 줄바꿈 제거
        columnDefinition = columnDefinition.replace(/[\r\n]+/g, '');

        // 컬럼 정의 끝에 ')'가 있으면 제거
        columnDefinition = columnDefinition.replace(/\)+$/, ')');

        // 'CREATE' 키워드가 포함되지 않도록 필터링
        if (columnName && columnName.toLowerCase() !== 'create') {
            requiredColumns.push({ name: columnName, definition: columnDefinition });
        }
    }

    // console.log('requiredColumns', requiredColumns);

    // 데이터베이스에서 현재 테이블의 실제 컬럼 가져오기
    const [existingColumns] = await connection.query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
        [tableName]
    );

    // console.log('existingColumns', existingColumns);
    const existingColumnNames = existingColumns.map(row => row.COLUMN_NAME);

    // txt 파일에 없는 컬럼 삭제
    for (const existingColumn of existingColumnNames) {
        if (!requiredColumns.some(col => col.name === existingColumn) && existingColumn !== 'id') {
            console.log(`컬럼 ${existingColumn} 삭제 중...`);
            await connection.query(`ALTER TABLE ${tableName} DROP COLUMN ${existingColumn}`);
        }
    }

    // txt 파일 기준으로 필요한 컬럼 추가
    for (const column of requiredColumns) {
        const existingColumn = existingColumns.find(col => col.COLUMN_NAME === column.name);

        if (!existingColumn) {
            console.log(`컬럼 ${column.name} 추가 중...`);
            await connection.query(`ALTER TABLE ${tableName} ADD COLUMN ${column.name} ${column.definition}`);
        } else {
            console.log(`컬럼 ${column.name} 이미 있는 항목 추가 X`);
        }
    }

    // id 필드 체크 및 추가
    const idColumnExists = existingColumnNames.includes('id');
    if (!idColumnExists) {
        console.log(`컬럼 id 추가 중...`);
        await connection.query(`ALTER TABLE ${tableName} ADD COLUMN id INT AUTO_INCREMENT PRIMARY KEY`);
    }
}





// 파일 경로 내 모든 파일을 처리하는 함수
async function processAllTxtFiles(directoryPath) {
    try {
        // MySQL 연결
        const connection = await mysql.createConnection(dbConfig);

        // 폴더 내의 모든 .txt 파일을 읽기
        const files = fs.readdirSync(directoryPath).filter(file => file.endsWith('.txt'));

        for (let file of files) {
            const filePath = path.join(directoryPath, file);
            console.log(`파일 처리 중: ${filePath}`);

            // 파일 내용 읽기
            const fileContent = await readFileContent(filePath);

            // 파일 내용에서 SQL 구문을 ';'로 구분하여 분할
            const queries = fileContent.split(';').map(query => query.trim()).filter(query => query.length > 0);

            let schemaName = null;
            const tablesInFile = {};

            for (let query of queries) {
                if (query.toLowerCase().startsWith('create schema')) {
                    // 스키마 이름 추출
                    const schemaNameMatch = query.match(/CREATE SCHEMA (\w+)/i);
                    schemaName = schemaNameMatch ? schemaNameMatch[1] : null;

                    if (schemaName) {
                        await ensureSchemaExists(connection, schemaName);
                    }
                } else if (query.toLowerCase().startsWith('create table')) {
                    // 테이블 이름 추출
                    const tableNameMatch = query.match(/CREATE TABLE IF NOT EXISTS (\w+)/i);
                    const tableName = tableNameMatch ? tableNameMatch[1] : null;

                    if (tableName) {
                        // 테이블 정보 저장
                        tablesInFile[tableName] = query;
                    }
                }
            }

            // 기존 테이블과 txt 파일의 테이블 동기화
            for (let tableName in tablesInFile) {
                // 테이블 존재 여부 확인
                const [tableExists] = await connection.query(
                    `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
                    [tableName]
                );

                if (tableExists.length > 0) {
                    // 컬럼 동기화
                    await syncColumns(connection, tableName, tablesInFile[tableName]);
                } else {
                    // 테이블이 존재하지 않는 경우, 생성
                    console.log(`테이블 ${tableName} 생성 중...`);
                    await connection.query(tablesInFile[tableName]);
                }
            }
        }

        // MySQL 연결 종료
        await connection.end();
        console.log('모든 파일 처리 완료');
    } catch (err) {
        console.error(`오류 발생: ${err.message}`);
    }
}

// Express 서버 시작
app.listen(3009, () => {
    console.log('서버가 3009번 포트에서 실행 중입니다.');

    // 파일 경로 설정
    const ipFileIpAddressPath = `${process.env.LOCALAPPDATA}\\Programs\\UIMD\\dbmigration`;

    // txt 파일 처리 시작
    processAllTxtFiles(ipFileIpAddressPath).catch(err => {
        console.error(`파일 처리 중 오류 발생: ${err.message}`);
    });
});
