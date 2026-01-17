const express = require('express');
const path = require('path');
const fs = require('fs');
const rangeParser = require('range-parser');
const bytes = require('bytes');
const NodeCache = require('node-cache');
const axios = require('axios');

// ✅ dotenv 要尽早加载，确保 MUSIC_DIR / ADMIN_PASSWORD 等环境变量在计算前就生效
require('dotenv').config();

const app = express();

// ✅ 兼容 HF：用 PORT 环境变量；本地默认 3000
const PORT = process.env.PORT || 3000;

// ✅ 你的音乐目录逻辑保持不变
const musicDir = path.join(__dirname, process.env.MUSIC_DIR || 'music');

// 管理密码
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';

function getContentType(ext) {
  const contentTypes = {
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.flac': 'audio/flac',
    '.m4a': 'audio/mp4'
  };
  return contentTypes[ext] || 'application/octet-stream';
}

// 确保音乐目录存在,不存在自动创建
if (!fs.existsSync(musicDir)) {
  fs.mkdirSync(musicDir, { recursive: true });
  console.log(`Created music directory: ${musicDir}`);
}

// 创建缓存实例，TTL 设置为1小时
const cache = new NodeCache({ 
  stdTTL: 7200,
  checkperiod: 120,
  maxKeys: 500  // 最多缓存500个文件的信息
});

// 流量统计
const stats = {
  totalBytes: 0,
  requests: 0
};

// JSON 格式化
app.set('json spaces', 2);

// 解析请求体的中间件
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 静态文件服务
app.use('/static', express.static(musicDir));

// CORS 中间件
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// 前端静态文件服务
app.use(express.static(path.join(__dirname, 'public')));

// 直链生成
app.get('/music/:filename', async (req, res) => {
  const filename = req.params.filename;
  
  // 检查文件名是否合法
  if (!filename.match(/^[\w\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fa5\uac00-\ud7af\u0e00-\u0e7f][\w\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fa5\uac00-\ud7af\u0e00-\u0e7f\s\-_.(),，（）+]+\.(mp3|wav|flac|m4a)$/i)) {
    return res.status(400).send('Invalid filename');
  }

  const normalizedPath = path.normalize(filename);
  if (normalizedPath.includes('..')) {
    return res.status(403).send('Access denied');
  }

  const filepath = path.join(musicDir, filename);

  // 从缓存获取文件信息
  let fileInfo = cache.get(filepath);
  if (!fileInfo) {
    try {
      const stat = await fs.promises.stat(filepath);
      fileInfo = {
        size: stat.size,
        mtime: stat.mtime.toUTCString(),
        exists: true
      };
      cache.set(filepath, fileInfo);
    } catch (err) {
      return res.status(404).send('File not found');
    }
  }

  const range = req.headers.range;

  // 通用响应头
  res.set({
    'Cache-Control': 'public, max-age=3600',
    'Last-Modified': fileInfo.mtime,
    'Accept-Ranges': 'bytes',
    'Content-Type': getContentType(path.extname(filename).toLowerCase()),
    'Content-Disposition': 'inline; filename*=UTF-8\'\'' + encodeURIComponent(filename),
    'X-Content-Type-Options': 'nosniff'
  });

  // 处理范围请求
  if (range) {
    const ranges = rangeParser(fileInfo.size, range);
    
    if (ranges === -1 || ranges === -2) {
      return res.status(416).send('Range not satisfiable');
    }

    const { start, end } = ranges[0];
    const chunk = end - start + 1;

    res.status(206);
    res.set({
      'Content-Range': `bytes ${start}-${end}/${fileInfo.size}`,
      'Content-Length': chunk
    });

    const stream = fs.createReadStream(filepath, { 
      start, 
      end,
      highWaterMark: 64 * 1024 // 64KB 缓冲区
    });

    stats.totalBytes += chunk;
    stats.requests += 1;

    stream.on('error', (error) => {
      console.error(`Stream error for ${filename}:`, error);
      if (!res.headersSent) {
        res.status(500).send('Internal server error');
      }
    });

    stream.pipe(res);
  } else {
    res.set({
      'Content-Length': fileInfo.size
    });

    const stream = fs.createReadStream(filepath, {
      highWaterMark: 64 * 1024 // 64KB 缓冲区
    });

    stats.totalBytes += fileInfo.size;
    stats.requests += 1;

    stream.on('error', (error) => {
      console.error(`Stream error for ${filename}:`, error);
      if (!res.headersSent) {
        res.status(500).send('Internal server error');
      }
    });

    stream.pipe(res);
  }
});

// 统计接口
app.get('/stats', (req, res) => {
  res.json({
    totalTransferred: bytes(stats.totalBytes),
    totalRequests: stats.requests
  });
});

// 下载音乐API
app.get('/api/download', async (req, res) => {
  const { url, name } = req.query;
  
  if (!url) {
    return res.status(400).json({ error: 'Please provide a music url' });
  }

  // 从 URL 中获取文件名和扩展名,解析带查询参数的URL
  const urlObj = new URL(url);
  let urlFileName = path.basename(urlObj.pathname);
  urlFileName = decodeURIComponent(urlFileName);
  const urlExt = path.extname(urlFileName).toLowerCase();

  if (!['.mp3', '.wav', '.flac', '.m4a'].includes(urlExt)) {
    return res.status(400).json({ error: 'Unsupported file format' });
  }

  // 使用提供的文件名或 URL 中的文件名
  const fullName = name ? (name + urlExt) : urlFileName;

  // 验证文件名格式
  if (!fullName.match(/^[\w\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fa5\uac00-\ud7af\u0e00-\u0e7f][\w\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fa5\uac00-\ud7af\u0e00-\u0e7f\s\-_.(),，（）+]+\.(mp3|wav|flac|m4a)$/i)) {
    return res.status(400).json({ error: 'filename is wrong' });
  }

  const savePath = path.join(musicDir, fullName);

  // 检查文件是否已存在
  if (fs.existsSync(savePath)) {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.get('host');
    const fileUrl = `${protocol}://${host}/music/${encodeURIComponent(fullName)}`;
    
    return res.status(200).json({
      warning: 'The song already exists',
      url: fileUrl
    });
  }

  // api返回响应
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.get('host');

  res.json({
    success: true,
    message: 'The song added to download list successfully',
    filename: fullName,
    futureUrl: `${protocol}://${host}/music/${encodeURIComponent(fullName)}`,
  });

  // 将音乐加入后台异步下载
  try {
    const response = await axios({
      method: 'GET',
      url: url,
      timeout: 300000,
      responseType: 'stream'
    });

    const writer = fs.createWriteStream(savePath);

    response.data.pipe(writer);

    writer.on('error', (err) => {
      console.error(`Download error for ${fullName}:`, err.message);
      fs.unlink(savePath, () => {});
    });

    writer.on('finish', () => {
      console.log(`Download finished ${fullName}`);
    });
  } catch (error) {
    console.error(`Download failed for ${fullName}:`, error.message);
    fs.unlink(savePath, () => {});
  }
});

// 获取音乐文件大小
function formatFileSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;
  
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  
  return `${size.toFixed(2)}${units[unitIndex]}`;
}

// 获取音乐列表 API
app.get('/api/music/list', async (req, res) => {
  try {
    const files = await fs.promises.readdir(musicDir);
    const musicFiles = files.filter(file => 
      ['.mp3', '.wav', '.flac', '.m4a'].includes(path.extname(file).toLowerCase())
    );

    // ✅ 这里协议判断更稳：优先 x-forwarded-proto（HF/反代环境常用）
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.get('host');

    const musicList = await Promise.all(musicFiles.map(async file => {
      const filePath = path.join(musicDir, file);
      const stat = await fs.promises.stat(filePath);
      return {
        filename: file,
        url: `${protocol}://${host}/music/${encodeURIComponent(file)}`,
        size: formatFileSize(stat.size),
        extension: path.extname(file).slice(1).toUpperCase(),
        lastModified: stat.mtime.toLocaleString()
      };
    }));

    res.json({
      total: musicList.length,
      data: musicList
    });
  } catch (error) {
    res.status(500).json({
      error: 'Get music list failed',
      details: error.message
    });
  }
});

// 删除音乐API
app.post('/api/delete/music', async (req, res) => {
  const names = req.body.names || req.query.names;
  const password = req.body.password || req.query.password;
  const all = req.body.all || req.query.all;

  // 验证管理密码
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized: Invalid password' });
  }

  try {
    let filesToDelete = [];
    
    // 情况1: 删除所有音乐文件
    if (all === 'true') {
      const files = await fs.promises.readdir(musicDir);
      filesToDelete = files.filter(file => 
        ['.mp3', '.wav', '.flac', '.m4a'].includes(path.extname(file).toLowerCase())
      );
    } 
    // 情况2: 批量删除指定名称的音乐文件
    else if (names) {
      const nameList = typeof names === 'string' ? names.split(',') : names;
      const files = await fs.promises.readdir(musicDir);
      
      filesToDelete = files.filter(file => {
        const filenameWithoutExt = path.basename(file, path.extname(file));
        const songNamePart = filenameWithoutExt.split('-')[0].trim().toLowerCase();
        return nameList.some(name => 
          songNamePart === name.trim().toLowerCase() && 
          ['.mp3', '.wav', '.flac', '.m4a'].includes(path.extname(file).toLowerCase())
        );
      });
    } 
    else {
      return res.status(400).json({ error: 'Please provide names parameter or set all=true' });
    }

    if (filesToDelete.length === 0) {
      return res.status(404).json({ error: 'No matching songs found' });
    }

    // 删除所有匹配的文件
    await Promise.all(filesToDelete.map(async file => {
      const filePath = path.join(musicDir, file);
      await fs.promises.unlink(filePath);
      cache.del(filePath);
    }));

    res.json({
      success: true,
      message: `Deleted ${filesToDelete.length} song(s)`,
      deletedFiles: filesToDelete
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to delete song(s)',
      details: error.message
    });
  }
});

// ✅ 启动服务器：必须监听 0.0.0.0（HF/容器外网访问关键）
app.listen(PORT, '0.0.0.0', () => {
  console.log(`music service is running on port ${PORT}`);
});
