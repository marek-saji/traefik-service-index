function queryAllItems ()
{
    return Array.from(document.querySelectorAll('[data-service]'));
}

function moveFocus (offset)
{
    const all = queryAllItems();
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
            if (
                !(event.ctrlKey || event.altKey || event.metaKey)
                && /[a-z]/.test(event.key)
            )
            {
                queryAllItems()
                    .find((link) => link.textContent.startsWith(event.key))
                    ?.click();
            }
    }
}

window.addEventListener('keydown', handleKeyDown);
