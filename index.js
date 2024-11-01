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
            await connection.query(`CREATE SCHEMA ${mysql.escapeId(schemaName)}`);
        } else {
            console.log(`스키마 ${schemaName}는 이미 존재합니다.`);
        }

        await connection.query(`USE ${mysql.escapeId(schemaName)}`);
    } catch (err) {
        console.error(`스키마 확인 중 오류 발생: ${err.message}`);
        throw err;
    }
}

// 테이블 동기화 (컬럼 삭제, 추가 및 수정)
async function syncColumns(connection, tableName, createTableQuery) {
    const columnRegex = /(?:`?(\w+)`?\s+([^,]+))(?:,\s*)?/g;
    const requiredColumns = [];
    let match;

    // CREATE TABLE 쿼리에서 필요한 컬럼 추출
    while ((match = columnRegex.exec(createTableQuery)) !== null) {
        let columnName = match[1];
        let columnDefinition = match[2]?.trim();

        // 공백 및 불필요한 괄호 제거
        columnDefinition = columnDefinition.replace(/[\r\n]+/g, '').replace(/\)+$/, '');

        // 예약어 처리: 예약어는 백틱(`)으로 감싸야 함
        if (['CREATE', 'KEY', 'ORDER'].includes(columnName.toUpperCase())) {
            columnName = `\`${columnName}\``;
        }

        // 컬럼 정의가 비어 있지 않은지 확인
        if (!columnDefinition || columnDefinition === '') {
            console.error(`컬럼 정의가 비어 있습니다: ${columnName}`);
            continue;
        }

        requiredColumns.push({ name: columnName, definition: columnDefinition });
    }

    // 데이터베이스에서 기존 컬럼 정보 가져오기
    const [existingColumns] = await connection.query(
        `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT 
         FROM INFORMATION_SCHEMA.COLUMNS 
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
        [tableName]
    );

    const existingColumnMap = {};
    existingColumns.forEach((col) => {
        existingColumnMap[col.COLUMN_NAME] = col;
    });

    // 컬럼 추가 및 수정
    for (const column of requiredColumns) {
        const existingColumn = existingColumnMap[column.name];

        if (!existingColumn) {
            // 컬럼이 없을 때만 추가
            try {
                console.log(`컬럼 ${column.name} 추가 중...`);
                await connection.query(`ALTER TABLE ${mysql.escapeId(tableName)} ADD COLUMN ${column.name} ${column.definition}`);
            } catch (err) {
                console.error(`컬럼 ${column.name} 추가 중 오류 발생: ${err.message}`);
            }
        } else {
            // 속성 값이 다를 때만 수정
            const currentDefinition = `${existingColumn.COLUMN_TYPE}${existingColumn.IS_NULLABLE === 'NO' ? ' NOT NULL' : ''}${existingColumn.COLUMN_DEFAULT ? ` DEFAULT ${existingColumn.COLUMN_DEFAULT}` : ''}`.trim();

            if (currentDefinition !== column.definition) {
                try {
                    console.log(`컬럼 ${column.name} 속성 수정 중...`);
                    await connection.query(`ALTER TABLE ${mysql.escapeId(tableName)} MODIFY COLUMN ${column.name} ${column.definition}`);
                } catch (err) {
                    console.error(`컬럼 ${column.name} 속성 수정 중 오류 발생: ${err.message}`);
                }
            }
        }
    }

    // id 필드 추가
    if (!existingColumnMap['id']) {
        try {
            console.log(`컬럼 id 추가 중...`);
            await connection.query(`ALTER TABLE ${mysql.escapeId(tableName)} ADD COLUMN id INT AUTO_INCREMENT PRIMARY KEY`);
        } catch (err) {
            console.error(`컬럼 id 추가 중 오류 발생: ${err.message}`);
        }
    }
}



// 파일 경로 내 모든 파일을 처리하는 함수
async function processAllTxtFiles(directoryPath) {
    try {
        const connection = await mysql.createConnection(dbConfig);

        const files = fs.readdirSync(directoryPath).filter(file => file.endsWith('.txt'));

        for (let file of files) {
            const filePath = path.join(directoryPath, file);
            console.log(`파일 처리 중: ${filePath}`);

            const fileContent = await readFileContent(filePath);

            const queries = fileContent.split(';').map(query => query.trim()).filter(query => query.length > 0);

            let schemaName = null;
            const tablesInFile = {};

            for (let query of queries) {
                if (query.toLowerCase().startsWith('create schema')) {
                    const schemaNameMatch = query.match(/CREATE SCHEMA (\w+)/i);
                    schemaName = schemaNameMatch ? schemaNameMatch[1] : null;

                    if (schemaName) {
                        await ensureSchemaExists(connection, schemaName);
                    }
                } else if (query.toLowerCase().startsWith('create table')) {
                    const tableNameMatch = query.match(/CREATE TABLE IF NOT EXISTS (\w+)/i);
                    const tableName = tableNameMatch ? tableNameMatch[1] : null;

                    if (tableName) {
                        tablesInFile[tableName] = query;
                    }
                }
            }

            for (let tableName in tablesInFile) {
                try {
                    const [tableExists] = await connection.query(
                        `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
                        [tableName]
                    );

                    if (tableExists.length > 0) {
                        await syncColumns(connection, tableName, tablesInFile[tableName]);
                    } else {
                        console.log(`테이블 ${tableName} 생성 중...`);
                        await connection.query(tablesInFile[tableName]);
                    }
                } catch (err) {
                    console.error(`테이블 ${tableName} 처리 중 오류 발생: ${err.message}`);
                }
            }
        }

        await connection.end();
        console.log('모든 파일 처리 완료');
    } catch (err) {
        console.error(`오류 발생: ${err.message}`);
    }
}

// Express 서버 시작
app.listen(3009, () => {
    console.log('서버가 3009번 포트에서 실행 중입니다.');

    const ipFileIpAddressPath = `${process.env.LOCALAPPDATA}\\Programs\\UIMD\\dbmigration`;

    processAllTxtFiles(ipFileIpAddressPath).catch(err => {
        console.error(`파일 처리 중 오류 발생: ${err.message}`);
    });
});
