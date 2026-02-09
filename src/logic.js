// PATH: ./src/logic.js
const sendBtn = document.getElementById('send-btn');
const input = document.getElementById('user-in');
const display = document.getElementById('text-display');
const sprite = document.getElementById('char-sprite');

sendBtn.onclick = async () => {
    const text = input.value;
    if(!text) return;

    display.innerText = "Thinking...";
    const response = await window.api.sendChat(text);

    // LOGIC: Look for [Mood: X] tags to swap images
    if (response.includes("[Mood: Happy]")) {
        sprite.src = "assets/happy.png";
    } else if (response.includes("[Mood: Sad]")) {
        sprite.src = "assets/sad.png";
    }
    
    // Show sprite if hidden and clean up text
    sprite.style.display = "block";
    display.innerText = response.replace(/\[Mood:.*?\]/g, "").trim();
    input.value = "";
};