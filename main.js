function moveFocus (offset)
{
    const all = Array.from(document.querySelectorAll('[data-service]'));
    const idx = all.findIndex(
        (node) => node === document.activeElement,
    );
    all.at((idx + offset) % all.length).focus();
}

function handleKeyDown (event)
{
    switch (event.key)
    {
        case 'ArrowDown':
            moveFocus(+1);
            break;
        case 'ArrowUp':
            moveFocus(-1);
            break;
        default:
    }
}

window.addEventListener('keydown', handleKeyDown);
