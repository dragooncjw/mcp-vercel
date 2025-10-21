// 测试 MCP 连接
const http = require('http');

// 测试 SSE 连接
function testSSEConnection() {
  console.log('🧪 测试 SSE 连接...');
  
  const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/api/sse',
    method: 'GET',
    headers: {
      'Accept': 'text/event-stream',
      'Cache-Control': 'no-cache',
    }
  };

  const req = http.request(options, (res) => {
    console.log(`📡 SSE 响应状态: ${res.statusCode}`);
    console.log(`📡 SSE 响应头:`, res.headers);
    
    res.on('data', (chunk) => {
      const data = chunk.toString();
      console.log(`📨 SSE 数据: ${data.trim()}`);
    });
    
    res.on('end', () => {
      console.log('🔚 SSE 连接结束');
    });
  });

  req.on('error', (err) => {
    console.error('❌ SSE 请求错误:', err.message);
  });

  req.end();
}

// 测试 POST 连接
async function testPostConnection() {
  console.log('\n🧪 测试 POST 连接...');
  
  const postData = JSON.stringify({
    jsonrpc: '2.0',
    id: 'test-' + Date.now(),
    method: 'initialize',
    params: {
      clientInfo: { name: 'test-client', version: '1.0' },
      capabilities: {}
    }
  });

  const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/api/mcp',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData),
      'Accept': 'application/json',
    }
  };

  const req = http.request(options, (res) => {
    console.log(`📡 POST 响应状态: ${res.statusCode}`);
    console.log(`📡 POST 响应头:`, res.headers);
    
    let data = '';
    res.on('data', (chunk) => {
      data += chunk;
    });
    
    res.on('end', () => {
      console.log(`📨 POST 响应数据: ${data}`);
    });
  });

  req.on('error', (err) => {
    console.error('❌ POST 请求错误:', err.message);
  });

  req.write(postData);
  req.end();
}

// 运行测试
console.log('🚀 开始测试 MCP 连接...\n');
testSSEConnection();
setTimeout(() => testPostConnection(), 2000);