const fs = require('fs').promises;
const { 
  initializeTracker, 
  getTrackerState, 
  restoreTrackerFromState,
  clearTracker 
} = require('./dist/index.mjs');

const { 
  saveResumeState, 
  loadResumeState, 
  deleteResumeState 
} = require('./dist/index.mjs');

async function testTrackerCheckpoint() {
  console.log('Testing tracker checkpoint functionality...');
  
  const filePath = 'test-file.js';
  const originalCode = 'function e(e,t){var n=[];return n}';
  const sessionId = 'test-session-123';
  
  try {
    // 1. 初始化tracker并记录一些重命名
    console.log('1. Initializing tracker...');
    const tracker = initializeTracker(filePath, originalCode);
    
    // 模拟一些重命名操作（这里只是示例，实际会在AST遍历中调用）
    console.log('2. Simulating some renames...');
    
    // 获取tracker状态
    const trackerState = getTrackerState(filePath);
    console.log('3. Tracker state:', trackerState ? 'Retrieved' : 'Not found');
    
    if (trackerState) {
      // 创建resume状态并保存
      const resumeState = {
        code: 'function splitString(inputString, chunkSize) { var chunks = []; return chunks; }',
        renames: ['splitString', 'inputString', 'chunkSize', 'chunks'],
        visited: ['e', 't', 'n'],
        currentIndex: 3,
        totalScopes: 4,
        codePath: filePath,
        trackerState: trackerState
      };
      
      console.log('4. Saving resume state with tracker state...');
      await saveResumeState(resumeState, sessionId);
      console.log('   Resume state saved successfully');
      
      // 清理当前tracker
      clearTracker(filePath);
      console.log('5. Cleared current tracker');
      
      // 加载resume状态
      console.log('6. Loading resume state...');
      const loadedResumeState = await loadResumeState(sessionId);
      
      if (loadedResumeState && loadedResumeState.trackerState) {
        console.log('7. Restoring tracker from resume state...');
        const restoredTracker = restoreTrackerFromState(loadedResumeState.trackerState);
        console.log('   Tracker restored successfully');
        
        // 验证恢复的状态
        const restoredTrackerState = getTrackerState(loadedResumeState.trackerState.filePath);
        console.log('8. Verification:');
        console.log('   - Original rename records:', trackerState.renameRecords.length);
        console.log('   - Restored rename records:', restoredTrackerState ? restoredTrackerState.renameRecords.length : 0);
        console.log('   - States match:', JSON.stringify(trackerState) === JSON.stringify(restoredTrackerState));
        
        // 清理
        await deleteResumeState(sessionId);
        clearTracker(loadedResumeState.trackerState.filePath);
        console.log('9. Cleanup completed');
        
        console.log('✅ Tracker checkpoint test completed successfully!');
      } else {
        console.log('❌ Failed to load tracker state from resume state');
      }
    } else {
      console.log('❌ Failed to get tracker state');
    }
    
  } catch (error) {
    console.error('❌ Test failed with error:', error);
  }
}

testTrackerCheckpoint(); 