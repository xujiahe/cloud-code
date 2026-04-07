// 公共布局辅助：注入导航栏和 Tab 切换逻辑
window.initLayout = function (title, tabs) {
  document.title = title + ' — Canvas 示例';

  const nav = document.createElement('nav');
  nav.innerHTML = `
    <a href="index.html" class="back">← 返回目录</a>
    <span class="nav-title">${title}</span>
  `;
  document.body.prepend(nav);

  const tabBar = document.getElementById('tab-bar');
  const panels = document.querySelectorAll('.panel');

  tabs.forEach((label, i) => {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.className = i === 0 ? 'active' : '';
    btn.onclick = () => {
      tabBar.querySelectorAll('button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      panels.forEach((p, j) => p.style.display = j === i ? 'flex' : 'none');
      // 触发 resize 让 canvas 重绘
      window.dispatchEvent(new Event('tabchange'));
    };
    tabBar.appendChild(btn);
  });

  panels.forEach((p, i) => { p.style.display = i === 0 ? 'flex' : 'none'; });
};
