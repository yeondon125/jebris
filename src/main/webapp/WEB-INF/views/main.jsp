<%@ page contentType="text/html; charset=UTF-8" pageEncoding="UTF-8" %>
<%@ page import="jebris.util.H, jebris.dto.ChatLog, java.util.List" %>
<%
    String ctx = request.getContextPath();
    String pageTitle = "메인";
    String activeMenu = "main";
    @SuppressWarnings("unchecked")
    List<ChatLog> recentChats = (List<ChatLog>) request.getAttribute("recentChats");
    boolean dbError = request.getAttribute("dbError") != null;
%>
<!DOCTYPE html>
<html lang="ko">
<head>
<%@ include file="/WEB-INF/views/common/head.jspf" %>
<script src="<%= ctx %>/js/clap.js" defer></script>
<script src="<%= ctx %>/js/gestures.js" defer></script>
<script src="<%= ctx %>/js/holo.js" defer></script>
<script src="<%= ctx %>/js/jarvis.js" defer></script>
<script type="module" src="<%= ctx %>/js/vision.js"></script>
</head>
<body class="app-page" data-ctx="<%= H.e(ctx) %>">
<%@ include file="/WEB-INF/views/common/nav.jspf" %>

<main class="main-grid">
    <!-- 왼쪽: 다가오는 일정 -->
    <aside class="panel schedule-panel">
        <div class="panel-head">
            <h2>다가오는 일정</h2>
            <a href="<%= ctx %>/schedule" class="link-sm">전체 보기</a>
        </div>
        <ul class="today-list" id="todayList">
            <li class="empty">일정을 불러오는 중...</li>
        </ul>
        <div class="panel-foot">
            <p class="hint-title">이렇게 말해 보세요</p>
            <ul class="hint-list">
                <li>“금요일 저녁 7시에 축구 추가해줘”</li>
                <li>“내일 일정 뭐 있어?”</li>
                <li>“오늘 할 일 정리해줘”</li>
            </ul>
        </div>
    </aside>

    <!-- 가운데: 제브리스 코어 -->
    <section class="core-area">
        <div class="clock">
            <div class="clock-time" id="clockTime">--:--</div>
            <div class="clock-date" id="clockDate"></div>
        </div>

        <!-- 홀로그램 코어 (js/holo.js가 SVG를 그림) -->
        <div class="holo" id="core" data-state="idle">
            <div class="holo-glow" aria-hidden="true"></div>
            <div class="holo-label">
                <div class="holo-name">J.E.B.R.I.S</div>
                <div class="state-label" id="stateLabel">대기 중</div>
            </div>
        </div>
        <div class="transcript" id="transcript">마이크를 누르고 말을 걸어 보세요</div>

        <button type="button" class="mic-btn" id="micBtn" aria-label="말하기 시작">
            <svg viewBox="0 0 24 24" width="34" height="34" aria-hidden="true">
                <path fill="currentColor" d="M12 15a3.5 3.5 0 0 0 3.5-3.5v-6a3.5 3.5 0 1 0-7 0v6A3.5 3.5 0 0 0 12 15Zm6-3.5a1 1 0 1 1 2 0 8 8 0 0 1-7 7.94V21a1 1 0 1 1-2 0v-1.56A8 8 0 0 1 4 11.5a1 1 0 1 1 2 0 6 6 0 0 0 12 0Z"/>
            </svg>
        </button>
        <p class="mic-hint">클릭하거나 <kbd>Space</kbd>를 눌러 말하기</p>

        <form class="text-form" id="textForm" autocomplete="off">
            <input type="text" id="textInput" maxlength="500" placeholder="말 대신 입력해도 돼요">
            <button type="submit" class="btn btn-primary">보내기</button>
        </form>

        <label class="switch">
            <input type="checkbox" id="voiceToggle" checked>
            <span class="switch-track"><span class="switch-thumb"></span></span>
            <span>음성으로 답하기</span>
        </label>

        <p class="warn" id="speechWarn" hidden>이 브라우저는 음성 인식을 지원하지 않아요. 크롬이나 엣지에서 열거나, 위 입력창을 사용해 주세요.</p>
        <% if (dbError) { %>
            <p class="warn">데이터베이스에 연결하지 못했어요. Oracle 실행 상태와 config.properties를 확인해 주세요.</p>
        <% } %>
    </section>

    <!-- 오른쪽: 대화 + 웹캠(신체 활동 인식) -->
    <div class="right-col">
    <aside class="panel chat-panel">
        <div class="panel-head">
            <h2>대화</h2>
            <a href="<%= ctx %>/history" class="link-sm">기록 보기</a>
        </div>
        <div class="chat-log" id="chatLog">
            <% if (recentChats == null || recentChats.isEmpty()) { %>
                <div class="chat-empty" id="chatEmpty">
                    <p>아직 대화가 없어요.</p>
                    <p>“안녕, 제브리스”라고 말해 보세요.</p>
                </div>
            <% } else {
                   for (ChatLog c : recentChats) { %>
                <div class="msg msg-user"><div class="bubble"><%= H.e(c.getQuestion()) %></div></div>
                <div class="msg msg-assistant">
                    <div class="bubble"><%= H.e(c.getAnswer()) %></div>
                    <div class="msg-meta"><%= H.e(H.intentLabel(c.getIntent())) %> · <%= H.e(H.time(c.getCreatedAt())) %></div>
                </div>
            <%     }
               } %>
        </div>
    </aside>

            <section class="panel vision-panel" id="visionPanel">
                <div class="vision-head">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8a2 2 0 0 1 2-2h2l2-2h6l2 2h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="12" cy="13" r="3.5"/></svg>
                    <h2>사용자 신체 활동 인식</h2>
                    <span class="live" id="camLive" hidden><i></i>LIVE</span>
                </div>

                <div class="cam" id="cam">
                    <video id="camVideo" muted playsinline></video>
                    <canvas id="camCanvas"></canvas>
                    <span class="cam-corner tl"></span><span class="cam-corner tr"></span><span class="cam-corner bl"></span><span class="cam-corner br"></span>
                    <div class="cam-cover" id="camCover">
                        <button type="button" class="btn btn-primary btn-sm" id="senseBtn">카메라 · 박수 감지 켜기</button>
                        <p>영상은 이 브라우저 안에서만 분석돼요</p>
                    </div>
                </div>

                <div class="act">
                    <div>
                        <div class="act-label">현재 동작</div>
                        <div class="act-name" id="actName">카메라 꺼짐</div>
                    </div>
                    <div class="act-conf" id="actConf">--</div>
                </div>
                <div class="bar"><span id="actBar"></span></div>

                <div class="hand-count"><span id="handCount"></span>
                    <label class="check dbg-toggle"><input type="checkbox" id="debugToggle"> 판정 수치</label></div>
                <div class="g-debug" id="gDebug" hidden></div>

                <div class="g-log-wrap">
                    <span class="act-label">인식된 제스처</span>
                    <div class="g-log" id="gestureLog"><span class="g-empty">👏 박수 두 번 · 👋 흔들기 · ✋ 손바닥</span></div>
                </div>

                <div class="trigger-row">
                    <label for="triggerMode">호출 방식</label>
                    <select id="triggerMode">
                        <option value="motion" selected>박수 동작 (웹캠)</option>
                        <option value="sound">박수 소리 (마이크)</option>
                        <option value="both">둘 다</option>
                    </select>
                    <span class="clap-status" id="clapStatus">꺼짐</span>
                </div>
                <div class="clap-row" id="soundRow" hidden>
                    <span class="act-label">소리</span>
                    <div class="clap-meter" title="마이크 소리 크기 / 박수 기준선">
                        <span class="clap-level" id="clapLevel"></span>
                        <span class="clap-thresh" id="clapThresh"></span>
                    </div>
                </div>
                <label class="check" id="needPersonWrap" hidden><input type="checkbox" id="needPerson" checked> 소리 박수는 사람이 보일 때만 반응</label>
            </section>
    </div>
</main>
</body>
</html>
