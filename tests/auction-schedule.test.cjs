const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
test('independent early and near-window auction schedules do not share a lock',()=>{
 const s=read('.github/workflows/auction-snapshot.yml');
 for(const cron of ['37 23 * * 0-4','17,47 0 * * 1-5','5,15,23,25 1 * * 1-5'])assert.ok(s.includes(cron));
 assert.ok(s.includes('group: auction-snapshot-${{ github.run_id }}'));
 assert.ok(s.includes('cancel-in-progress: false'));
 assert.ok(s.indexOf('publish-auction-data.sh capture')<s.indexOf('--score-only'));
});
test('rescue runs after scheduled collection and reports missing input as failure',()=>{
 const s=read('.github/workflows/auction-score-rescue.yml');
 assert.ok(s.includes('workflow_run:'));assert.ok(s.includes('32,42,52 1'));
 assert.ok(s.includes('12 2'));assert.ok(s.includes('--score-only'));
 assert.ok(s.includes('::error::No saved 09:25'));assert.ok(s.includes('exit 1'));
});
test('publication race adopts remote capture contents before scoring',()=>{
 const s=read('scripts/publish-auction-data.sh');
 assert.ok(s.includes('git restore --source=origin/main --worktree -- "$target"'));
});
