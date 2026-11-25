// Built-in prompts. Used as a fallback when Groq is unavailable, and as the whole
// "AI" in mock mode (GROQ_MOCK=1 or no GROQ_API_KEY) so the game is testable offline.
// share = rough % of players expected to give that answer; extra strings are aliases.
export type SeedAnswer = [string, number, string[]?];
export type SeedPrompt = { id: string; text: string; category: string; answers: SeedAnswer[] };

export const SEED_POOL: SeedPrompt[] = [
 {id:"planet", category:"space", text:"Name a planet or dwarf planet", answers:[
  ["Mars",30],["Jupiter",18],["Saturn",15],["Earth",8],["Venus",6],["Pluto",6],["Mercury",5],["Neptune",5],["Uranus",4],
  ["Ceres",1],["Eris",.5],["Haumea",.15],["Makemake",.15,["make make"]],["Sedna",.1],["Quaoar",.06],["Gonggong",.04],["Orcus",.04]]},
 {id:"flightless", category:"nature", text:"Name a bird that can't fly", answers:[
  ["Penguin",45],["Ostrich",25],["Emu",10],["Kiwi",8],["Dodo",5],["Cassowary",3],["Chicken",1],["Rhea",1],["Kakapo",1],
  ["Moa",.5],["Takahe",.3],["Great auk",.2],["Elephant bird",.2],["Weka",.1],["Flightless cormorant",.1,["galapagos cormorant"]],["Steamer duck",.05]]},
 {id:"astronaut", category:"space", text:"Name a real astronaut or cosmonaut", answers:[
  ["Neil Armstrong",40,["armstrong"]],["Buzz Aldrin",15,["aldrin"]],["Yuri Gagarin",15,["gagarin"]],["Sally Ride",4],["John Glenn",4],
  ["Chris Hadfield",3,["hadfield"]],["Valentina Tereshkova",2,["tereshkova"]],["Alan Shepard",2],["Michael Collins",2],["Sunita Williams",2,["suni williams"]],
  ["Kalpana Chawla",1.5,["chawla"]],["Rakesh Sharma",1.5],["Scott Kelly",1],["Mae Jemison",1],["Jim Lovell",.8],["Tim Peake",.8],["Peggy Whitson",.5],
  ["Alexei Leonov",.5,["leonov"]],["Eileen Collins",.3],["Christina Koch",.3],["Thomas Pesquet",.3],["Samantha Cristoforetti",.3],["Gene Cernan",.3],
  ["Yang Liwei",.2],["Ed White",.2],["Gus Grissom",.2],["Pete Conrad",.1],["Shubhanshu Shukla",.1],["Jessica Meir",.1],["Wally Schirra",.05]]},
 {id:"redfruit", category:"food", text:"Name a fruit that's usually red", answers:[
  ["Apple",35],["Strawberry",25],["Cherry",15],["Raspberry",5],["Watermelon",4],["Pomegranate",3],["Cranberry",2],["Tomato",2],["Red grape",1,["grape"]],
  ["Plum",1],["Lychee",.8,["litchi"]],["Dragon fruit",.8,["pitaya"]],["Blood orange",.5],["Red currant",.4,["currant"]],["Rambutan",.3],["Mulberry",.3],
  ["Guava",.3],["Lingonberry",.2],["Goji berry",.2,["goji"]],["Prickly pear",.2],["Acerola",.1],["Red banana",.1],["Barberry",.05],["Salmonberry",.05]]},
 {id:"wings", category:"nature", text:"Name something with wings that isn't a bird", answers:[
  ["Airplane",35,["plane","aeroplane","jet"]],["Butterfly",15],["Bee",8],["Bat",8],["Dragonfly",5],["Fly",5,["housefly"]],["Dragon",4],["Angel",3],
  ["Mosquito",2],["Moth",2],["Wasp",1],["Ladybug",1,["ladybird"]],["Fairy",1],["Pegasus",1],["Pterodactyl",1,["pterosaur"]],["Glider",1],
  ["Flying fish",.5],["Beetle",.5],["Grasshopper",.3],["Cicada",.3],["Griffin",.3,["gryphon"]],["Cupid",.2],["Termite",.1],["Maple seed",.1,["samara"]],["Lacewing",.05],["Mayfly",.08]]},
 {id:"boardgame", category:"games", text:"Name a board game", answers:[
  ["Monopoly",30],["Chess",20],["Scrabble",10],["Checkers",5,["draughts"]],["Clue",5,["cluedo"]],["Ludo",4],["Risk",4],["Catan",4,["settlers of catan"]],
  ["Snakes and ladders",3,["chutes and ladders"]],["Battleship",2],["Sorry",2],["Candy Land",2],["Trivial Pursuit",1.5],["Go",1.5,["weiqi","baduk"]],
  ["Backgammon",1.5],["Connect Four",1,["connect 4"]],["Guess Who",1],["Ticket to Ride",.8],["Carrom",.5],["Pandemic",.5],["Operation",.5],["Mancala",.4],
  ["Othello",.4,["reversi"]],["Carcassonne",.4],["Stratego",.3],["Codenames",.3],["Azul",.2],["Wingspan",.2],["Terraforming Mars",.15],["Splendor",.1],
  ["Diplomacy",.1],["Gloomhaven",.1],["Scythe",.08],["Agricola",.08],["Hive",.05],["Root",.05],["Twilight Imperium",.05],["Tsuro",.05]]},
 {id:"instrument", category:"music", text:"Name a musical instrument", answers:[
  ["Guitar",30],["Piano",25],["Drums",10,["drum"]],["Violin",10,["fiddle"]],["Flute",5],["Trumpet",4],["Saxophone",3,["sax"]],["Cello",2],["Harp",1.5],
  ["Clarinet",1.5],["Ukulele",1],["Bass",1,["bass guitar","double bass"]],["Tabla",1],["Sitar",.8],["Harmonica",.5],["Accordion",.5],["Trombone",.5],
  ["Xylophone",.5],["Organ",.3],["Oboe",.3],["Bagpipes",.3],["Banjo",.3],["Tuba",.3],["Triangle",.3],["Harmonium",.2],["Mandolin",.2],["Viola",.2],
  ["Bassoon",.15],["Veena",.1],["Didgeridoo",.1],["Kazoo",.1],["Marimba",.08],["Theremin",.05],["Sarod",.05],["Santoor",.05],["Shehnai",.05],
  ["Mridangam",.05],["Glockenspiel",.05],["Ocarina",.05],["Lute",.05],["Harpsichord",.05],["Djembe",.05],["Cajon",.05],["Erhu",.03],["Koto",.03],["Hurdy-gurdy",.02]]},
 {id:"metal", category:"science", text:"Name a metal", answers:[
  ["Gold",30],["Iron",25],["Silver",15],["Copper",8],["Aluminium",6,["aluminum"]],["Steel",5],["Platinum",2],["Titanium",2],["Lead",1.5],["Zinc",1],
  ["Tin",1],["Nickel",.8],["Mercury",.5],["Brass",.5],["Bronze",.5],["Tungsten",.4],["Lithium",.3],["Magnesium",.3],["Uranium",.3],["Sodium",.2],
  ["Cobalt",.2],["Chromium",.2,["chrome"]],["Potassium",.15],["Calcium",.1],["Plutonium",.1],["Palladium",.08],["Osmium",.05],["Iridium",.05],
  ["Gallium",.05],["Bismuth",.05],["Manganese",.05],["Rhodium",.03],["Vanadium",.03],["Beryllium",.03],["Caesium",.03,["cesium"]],["Niobium",.02],
  ["Tantalum",.02],["Molybdenum",.02],["Neodymium",.02],["Thorium",.02],["Francium",.01],["Hafnium",.01],["Scandium",.01],["Ruthenium",.01],["Rhenium",.01],["Yttrium",.01]]},
 {id:"africa", category:"geography", text:"Name a country in Africa", answers:[
  ["Egypt",20],["Nigeria",15],["South Africa",15],["Kenya",10],["Ethiopia",5],["Ghana",4],["Morocco",4],["Algeria",2],["Somalia",2],["Sudan",2],
  ["Uganda",1.5],["Tanzania",1.5],["Zimbabwe",1.5],["Madagascar",1.5],["Libya",1.2],["Tunisia",1],["Congo",1,["republic of the congo","drc","democratic republic of the congo"]],
  ["Rwanda",1],["Senegal",.8],["Cameroon",.8],["Namibia",.7],["Botswana",.6],["Angola",.6],["Mozambique",.5],["Zambia",.5],["Mali",.5],["Ivory Coast",.5,["cote d'ivoire","cote divoire"]],
  ["Niger",.4],["Chad",.4],["Mauritius",.4],["Malawi",.3],["Sierra Leone",.3],["Liberia",.3],["Eritrea",.25],["Burkina Faso",.2],["South Sudan",.2],
  ["Benin",.15],["Togo",.15],["Gambia",.15],["Guinea",.12],["Mauritania",.12],["Lesotho",.1],["Eswatini",.1,["swaziland"]],["Gabon",.1],["Burundi",.1],
  ["Djibouti",.1],["Seychelles",.1],["Cape Verde",.08,["cabo verde"]],["Central African Republic",.08,["car"]],["Equatorial Guinea",.05],["Guinea-Bissau",.05],
  ["Comoros",.05],["Sao Tome and Principe",.03,["sao tome"]]]},
 {id:"constellation", category:"space", text:"Name a constellation", answers:[
  ["Orion",30],["Ursa Major",25,["big dipper","great bear","saptarishi"]],["Cassiopeia",8],["Ursa Minor",6,["little dipper"]],["Scorpius",5,["scorpio"]],
  ["Leo",4],["Gemini",3],["Taurus",3],["Andromeda",2],["Aries",2],["Cancer",2],["Sagittarius",2],["Virgo",2],["Libra",1.5],["Aquarius",1.5],["Pisces",1.5],
  ["Pegasus",1.5],["Capricornus",1,["capricorn"]],["Draco",1],["Cygnus",1],["Perseus",1],["Hercules",1],["Crux",1,["southern cross"]],["Canis Major",1],
  ["Lyra",.5],["Centaurus",.5],["Ophiuchus",.4],["Hydra",.3],["Corona Borealis",.3],["Bootes",.3],["Auriga",.3],["Aquila",.3],["Cetus",.2],["Phoenix",.2],
  ["Delphinus",.2],["Carina",.2],["Eridanus",.1],["Lepus",.1],["Lupus",.1],["Triangulum",.1],["Vela",.1],["Columba",.08],["Monoceros",.08],
  ["Camelopardalis",.05],["Fornax",.05],["Sculptor",.05],["Puppis",.05],["Pavo",.05],["Tucana",.05],["Sagitta",.05],["Pyxis",.03],["Vulpecula",.03],["Lacerta",.03]]}
];

// Extra built-in prompts (text only, no answer lists). Used for variety when the AI can't write new ones;
// the AI builds their rarity survey on demand. Easy, broad and a bit playful.
export const EXTRA_PROMPTS: { text: string; category: string }[] = [
  ["Name something that is sticky", "anything"], ["Name something you'd find in a junk drawer", "anything"], ["Name an excuse for being late", "anything"],
  ["Name something that melts", "anything"], ["Name something with wheels", "anything"], ["Name something that buzzes", "anything"],
  ["Name something you see at a wedding", "anything"], ["Name something in a hospital", "anything"], ["Name something at the airport", "anything"],
  ["Name something round", "anything"], ["Name something that smells amazing", "anything"], ["Name something you'd hate to step on", "anything"],
  ["Name something people collect", "anything"], ["Name a superpower", "anything"], ["Name something you do on a rainy day", "anything"],
  ["Name something in a toolbox", "anything"], ["Name something that glows", "anything"], ["Name something you put on a pizza", "food"],
  ["Name a green food", "food"], ["Name something you eat with a spoon", "food"], ["Name a crunchy snack", "food"], ["Name a spicy food", "food"],
  ["Name something you put in a smoothie", "food"], ["Name a street food", "food"], ["Name a food you eat at the cinema", "food"],
  ["Name something on a breakfast table", "food"], ["Name an animal that lives in the ocean", "nature"], ["Name an animal with a long tail", "nature"],
  ["Name something you find in a forest", "nature"], ["Name a bug", "nature"], ["Name a flower", "nature"], ["Name an animal that hops", "nature"],
  ["Name a type of weather", "nature"], ["Name something in a garden", "nature"], ["Name a musical instrument", "music"], ["Name a song everyone knows", "music"],
  ["Name a type of dance", "music"], ["Name something at a concert", "music"], ["Name a famous band", "music"], ["Name a movie with a dragon", "movies & tv"],
  ["Name a cartoon dog", "movies & tv"], ["Name a TV show about a family", "movies & tv"], ["Name a movie villain", "movies & tv"], ["Name a talking animal from a movie", "movies & tv"],
  ["Name a wizard", "movies & tv"], ["Name something in a classroom", "anything"], ["Name a school subject", "anything"], ["Name a board game", "games"],
  ["Name a video game character", "games"], ["Name a card game", "games"], ["Name a playground game", "games"], ["Name a sport played on ice", "sports"],
  ["Name something a goalkeeper wears", "sports"], ["Name an Olympic sport", "sports"], ["Name a sport with a net", "sports"], ["Name something at a stadium", "sports"],
  ["Name a country in Asia", "geography"], ["Name a city with a famous tower", "geography"], ["Name an island", "geography"], ["Name a river", "geography"],
  ["Name a desert animal", "geography"], ["Name something in space", "space"], ["Name something an astronaut takes to space", "space"], ["Name something that orbits", "space"],
  ["Name an invention", "science"], ["Name something with a battery", "science"], ["Name something magnetic", "science"], ["Name a body part", "science"],
  ["Name a famous castle", "history"], ["Name something a knight carries", "history"], ["Name an ancient civilization", "history"], ["Name something pirates have", "history"],
].map(([text, category]) => ({ text, category }));
