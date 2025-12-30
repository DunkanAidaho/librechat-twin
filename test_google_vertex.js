// /opt/open-webui/test_google_vertex.js
const { VertexAI } = require('@google-cloud/vertexai');

async function testVertexAI() {
  console.log('=== Testing Google Vertex AI ===');
  
  const project_id = 'turing-outrider-474015-s3';
  const location = 'us-central1';
  const model_name = 'gemini-2.5-pro';
  
  // Проверяем переменную окружения
  const authFile = process.env.GOOGLE_APPLICATION_CREDENTIALS || '/app/api/data/auth.json';
  console.log(`Auth file path: ${authFile}`);
  
  try {
    // Проверяем существование файла
    const fs = require('fs');
    if (!fs.existsSync(authFile)) {
      console.error(`❌ Auth file NOT FOUND at: ${authFile}`);
      return;
    }
    console.log(`✅ Auth file exists at: ${authFile}`);
    
    // Читаем содержимое (без вывода приватных ключей)
    const authData = JSON.parse(fs.readFileSync(authFile, 'utf8'));
    console.log(`✅ Auth file parsed successfully`);
    console.log(`   - type: ${authData.type}`);
    console.log(`   - project_id: ${authData.project_id}`);
    console.log(`   - client_email: ${authData.client_email}`);
    console.log(`   - private_key: ${authData.private_key ? '[EXISTS]' : '[MISSING]'}`);
    
    // Инициализируем Vertex AI
    console.log('\n--- Initializing Vertex AI ---');
    const vertexAI = new VertexAI({ project: project_id, location: location });
    console.log('✅ VertexAI instance created');
    
    // Создаем модель БЕЗ streaming
    console.log('\n--- Creating Generative Model (non-streaming) ---');
    const generativeModel = vertexAI.getGenerativeModel({
      model: model_name,
      generation_config: {
        maxOutputTokens: 100,
        temperature: 0.2,
      },
    });
    console.log('✅ Generative model created');
    
    // Тестовый запрос БЕЗ streaming
    console.log('\n--- Testing generateContent (non-streaming) ---');
    const request = {
      contents: [
        {
          role: 'user',
          parts: [{ text: 'Скажи "Привет" на русском языке.' }],
        },
      ],
    };
    
    console.log('Sending request...');
    const startTime = Date.now();
    const response = await generativeModel.generateContent(request);
    const elapsed = Date.now() - startTime;
    
    console.log(`✅ Response received in ${elapsed}ms`);
    
    if (!response.response) {
      console.error('❌ No response object');
      return;
    }
    
    if (!response.response.candidates || response.response.candidates.length === 0) {
      console.error('❌ No candidates in response');
      console.log('Response:', JSON.stringify(response.response, null, 2));
      return;
    }
    
    const candidate = response.response.candidates[0];
    if (!candidate.content || !candidate.content.parts || candidate.content.parts.length === 0) {
      console.error('❌ No content parts in candidate');
      console.log('Candidate:', JSON.stringify(candidate, null, 2));
      return;
    }
    
    const text = candidate.content.parts[0].text;
    console.log(`✅ Generated text: "${text}"`);
    
    // Проверяем streaming (это может вызвать ошибку)
    console.log('\n--- Testing streamGenerateContent (streaming) ---');
    try {
      const streamResponse = await generativeModel.generateContentStream(request);
      console.log('✅ Stream response object created');
      
      let streamText = '';
      for await (const chunk of streamResponse.stream) {
        if (chunk.candidates && chunk.candidates[0] && chunk.candidates[0].content) {
          const chunkText = chunk.candidates[0].content.parts[0].text || '';
          streamText += chunkText;
          process.stdout.write('.');
        }
      }
      console.log(`\n✅ Streaming completed. Text: "${streamText}"`);
    } catch (streamError) {
      console.error('❌ Streaming failed:', streamError.message);
      console.error('   This is the error LibreChat is experiencing!');
    }
    
    console.log('\n=== Test completed ===');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error('Stack:', error.stack);
    
    if (error.code) {
      console.error(`Error code: ${error.code}`);
    }
    
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
  }
}

testVertexAI().then(() => {
  console.log('\nTest finished. Exiting...');
  process.exit(0);
}).catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
