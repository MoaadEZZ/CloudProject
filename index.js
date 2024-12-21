const sql = require("mssql");
const config = {
    user: "diablo",
    password: "pabloescobar98.",
    server: "idkman.database.windows.net",
    database: "gameDB",
    options: {
        encrypt: true,
        trustServerCertificate: false
    }
};

const fs = require("fs");
const path = require("path");

function getPlayerStatus(lettersGuessed, wordToGuess) {
    // Convert the word to lowercase for case-insensitive comparison
    const word = wordToGuess.toLowerCase();

    // Initialize the current state of the word
    let currentState = word
        .split("")
        .map(letter => (lettersGuessed.includes(letter) ? letter : "_"))
        .join("");
    
    return currentState;

    }

let newGuestId = null;

// Azure Function entry point
module.exports = async function (context, req) {
    context.log("Request received:", req);

    const pool = await sql.connect(config);

    if (newGuestId == null) {
        // Fetch the total number of guests
        const result1 = await pool.request().query("SELECT COUNT(*) AS total FROM guests");
        const totalGuests = result1.recordset[0].total;

        // Create a new guest name
        const newGuestName = `guest${totalGuests + 1}`;

        // Insert the new guest into the database and get its ID
        const result = await pool
            .request()
            .input("name", sql.VarChar, newGuestName)
            .query("INSERT INTO guests (name) OUTPUT INSERTED.id AS newId VALUES (@name)");
            
        newGuestId = result.recordset[0].newId;
    }

    const action = (req.query && req.query.action) || (req.body && req.body.action);
    const gameId = req.body && req.body.gameId;
    const letter = req.body && req.body.letter;

    if (!action) {
        // Serve the index.html file for direct access
        const filePath = path.join(__dirname, "index.html");

        try {
            const htmlContent = fs.readFileSync(filePath, "utf8");
            context.res = {
                status: 200,
                headers: { "Content-Type": "text/html" },
                body: htmlContent
            };
        } catch (error) {
            context.log("Error serving index.html:", error);
            context.res = {
                status: 500,
                body: "Error: Unable to load the game page."
            };
        }
        return;
    }

    if (action === "start") {
        // Create a new game
        const words = await pool.request().query(
            "SELECT TOP 1 word FROM words ORDER BY NEWID()"
        );

        const randomWord = words.recordset[0]?.word; // Safely access the first record

        if (!randomWord) {
            context.res = {
                status: 500,
                body: "Error: No words found in the database."
            };
            return;
        }
        const newGameId = Math.random().toString(36).substring(2, 9);
        await pool.request()
            .input("gameId", sql.VarChar, newGameId)
            .input("wordToGuess", sql.VarChar, randomWord)
            .input("players", sql.Int, 1)
            .input("completed", sql.Bit, 0)
            .query(
                "INSERT INTO games (gameId, wordtoguess, players, completed) VALUES (@gameId, @wordToGuess, @players, @completed)"
            );

        await pool.request()
            .input("id_guest", sql.Int, newGuestId)
            .input("id_game", sql.VarChar, newGameId)
            .input("letters_guessed", sql.VarChar, "") 
            .query(
                "INSERT INTO guest_game (id_guest, id_game, letters_guessed) VALUES (@id_guest, @id_game, @letters_guessed)"
            );

        context.res = {
            status: 200,
            body: {
                gameId: newGameId,
                state: getPlayerStatus("", randomWord),
                message: "Game started! Share the game ID to join."
            }
        };
    } else if (action === "join") {
        // Join an existing game
        const result = await pool
            .request()
            .input("gameId", sql.VarChar, gameId)
            .query("SELECT * FROM games WHERE gameId = @gameId");
        if (result.recordset.length == 0) {
            context.res = { 
                status: 404,
                body: {
                    state: "_".repeat(5),
                    message: "Game ID not found."
                }
            };
            return;
        }
        const game = result.recordset[0];
        if (game.completed == 1 || game.completed == false) {
            context.res = {
                status: 200,
                body: {
                    state: getPlayerStatus("", game.wordtoguess),
                    message: "Game already over! you can't join."
                }
            };
            return;
        }
        if (game.players >= 2) {
            context.res = {
                status: 400,
                body: {
                    state: games[gameId].state,
                    message: "Game room is full."
                }
            };
            return;
        }
        
        await pool.request()
        .input("id_guest", sql.Int, newGuestId)
        .input("id_game", sql.VarChar, game.gameId)
        .input("letters_guessed", sql.VarChar, "") // Initially empty
        .query(
            "INSERT INTO guest_game (id_guest, id_game, letters_guessed) VALUES (@id_guest, @id_game, @letters_guessed)"
        );

        await pool.request()
        .input("gameId", sql.VarChar, gameId)
        .query(
            "UPDATE games SET players = players + 1 WHERE gameId = @gameId"
        );

        game.players += 1;
        context.res = {
            status: 200,
            body: {
                gameId: gameId,
                state: getPlayerStatus("", game.wordtoguess),
                message: "You joined the game! Start guessing letters."
            }
        };
    } else if (action === "guess") {
        // Handle guesses
        const resultgame = await pool
            .request()
            .input("gameId", sql.VarChar, gameId)
            .query("SELECT * FROM games WHERE gameId = @gameId");
        const resultguest = await pool
            .request()
            .input("guestId", sql.Int, newGuestId)
            .query("SELECT * FROM guests WHERE id = @guestId");
        const result = await pool
            .request()
            .input("id_guest", sql.Int, newGuestId)
            .input("id_game", sql.VarChar, gameId)
            .query("SELECT * FROM guest_game WHERE id_guest = @id_guest AND id_game = @id_game");
        if (resultgame.recordset.length == 0) {
            context.res = { status: 404, body: {message: "Game ID not found."} };
            return;
        }
        if (result.recordset.length == 0) {
            context.res = { status: 404, body: {message: "You are not allowed in this game."} };
            return;
        }
        const games = resultgame.recordset[0];
        const guest = resultguest.recordset[0];
        const guest_game = result.recordset[0];

        if (games.completed) {
            context.res = {
                status: 200,
                body: {
                    state: getPlayerStatus(guest_game.letters_guessed, games.wordtoguess),
                    message: "Game over! The word was guessed by your opponent :("
                }
            };
            return;
        }
        if (!letter || letter.length !== 1) {
            context.res = { status: 400, body: "Invalid guess. Please provide a single letter." };
            return;
        }

        if (guest_game.letters_guessed.includes(letter)) {
            context.res = { status: 200,
                 body: {
                    state: getPlayerStatus(guest_game.letters_guessed, games.wordtoguess),
                    message: "Letter already guessed.".concat(games.wordtoguess)} 
                };
            return;
        }
        const updatedLettersGuessed = guest_game.letters_guessed + letter;

        await pool.request()
            .input("guestId", sql.Int, guest.GuestID)
            .input("gameId", sql.VarChar, games.gameId)
            .input("letter", sql.VarChar, letter)
            .query(`
                UPDATE guest_game
                SET letters_guessed = CONCAT(letters_guessed, @letter)
                WHERE id_guest = @guestId AND id_game = @gameId
            `);

        if (!getPlayerStatus(updatedLettersGuessed, games.wordtoguess).includes("_")) {
            await pool.request()
            .input("gameId", sql.VarChar, gameId)
            .query(`
                UPDATE games
                SET completed = 1
                WHERE gameId = @gameId
            `);
            context.res = {
                status: 200,
                body: {
                    state: getPlayerStatus(updatedLettersGuessed, games.wordtoguess),
                    message: "Congratulations! The word has been guessed."
                }
            };
            return;
        }

        context.res = {
            status: 200,
            body: {
                state: getPlayerStatus(updatedLettersGuessed, games.wordtoguess),
                message: "Keep guessing!"
            }
        };
    } else {
        context.res = { status: 400, body: "Invalid action. Valid actions: start, join, guess." };
    }
};
